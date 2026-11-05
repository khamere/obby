use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{lookup_host, TcpStream};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::Message as WsMessage;

const ADDRESS_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const WEBSOCKET_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

// Platform-specific TLS imports
#[cfg(not(target_os = "android"))]
use native_tls::TlsConnector as NativeTlsConnector;
#[cfg(not(target_os = "android"))]
use tokio_native_tls::TlsConnector;

#[cfg(target_os = "android")]
use rustls::pki_types::ServerName;
#[cfg(target_os = "android")]
use std::sync::Arc as StdArc;
#[cfg(target_os = "android")]
use tokio_rustls::TlsConnector;

/// Connection handle for managing write operations and shutdown
#[derive(Debug)]
pub struct ConnectionHandle {
    write_tx: mpsc::Sender<String>,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

/// Socket state to manage multiple connections
#[derive(Clone)]
pub struct SocketState(pub(crate) Arc<Mutex<HashMap<String, ConnectionHandle>>>);

/// Payload we send back to TS whenever we receive data
#[derive(Serialize, Clone)]
struct ReceivedPayload {
    id: String,
    event: MessageEvent,
}

#[derive(Serialize, Clone)]
struct MessageEvent {
    message: Option<MessageData>,
    error: Option<String>,
    connected: Option<bool>,
}

#[derive(Serialize, Clone)]
struct MessageData {
    data: Vec<u8>,
}

/// Read task for handling incoming data from the socket
async fn read_task<R>(
    client_id: String,
    mut reader: R,
    app_handle: tauri::AppHandle,
    state: Arc<Mutex<HashMap<String, ConnectionHandle>>>,
) where
    R: AsyncReadExt + Unpin,
{
    let mut read_buf = vec![0u8; 4096];
    let mut line_buffer = Vec::new();

    loop {
        match reader.read(&mut read_buf).await {
            Ok(0) => {
                // Connection closed by server
                // Emit any remaining partial data as a final message
                if !line_buffer.is_empty() {
                    let _ = app_handle.emit(
                        "tcp-message",
                        ReceivedPayload {
                            id: client_id.clone(),
                            event: MessageEvent {
                                message: Some(MessageData {
                                    data: line_buffer.clone(),
                                }),
                                error: None,
                                connected: None,
                            },
                        },
                    );
                }

                let _ = app_handle.emit(
                    "tcp-message",
                    ReceivedPayload {
                        id: client_id.clone(),
                        event: MessageEvent {
                            message: None,
                            error: None,
                            connected: Some(false),
                        },
                    },
                );

                // Remove connection from state
                let mut connections = state.lock().await;
                connections.remove(&client_id);
                break;
            }
            Ok(n) => {
                // Append new data to line buffer
                line_buffer.extend_from_slice(&read_buf[..n]);

                while let Some(pos) = line_buffer.windows(2).position(|w| w == b"\r\n") {
                    let line_data = line_buffer[..pos + 2].to_vec();
                    line_buffer.drain(..pos + 2);

                    let _ = app_handle.emit(
                        "tcp-message",
                        ReceivedPayload {
                            id: client_id.clone(),
                            event: MessageEvent {
                                message: Some(MessageData { data: line_data }),
                                error: None,
                                connected: None,
                            },
                        },
                    );
                }
            }
            Err(e) => {
                // Read error - emit error event and stop
                let _ = app_handle.emit(
                    "tcp-message",
                    ReceivedPayload {
                        id: client_id.clone(),
                        event: MessageEvent {
                            message: None,
                            error: Some(format!("Read error: {}", e)),
                            connected: Some(false),
                        },
                    },
                );

                // Remove connection from state
                let mut connections = state.lock().await;
                connections.remove(&client_id);
                break;
            }
        }
    }
}

/// Write task for handling outgoing data to the socket
async fn write_task<W>(
    mut writer: W,
    mut write_rx: mpsc::Receiver<String>,
    mut shutdown_rx: oneshot::Receiver<()>,
) where
    W: AsyncWriteExt + Unpin,
{
    loop {
        tokio::select! {
            // Handle write commands
            Some(data) = write_rx.recv() => {
                // Add IRC line ending if not present
                let data_with_crlf = if data.ends_with("\r\n") {
                    data
                } else {
                    format!("{}\r\n", data)
                };

                if let Err(e) = writer.write_all(data_with_crlf.as_bytes()).await {
                    eprintln!("Write error: {}", e);
                    break;
                }

                if let Err(e) = writer.flush().await {
                    eprintln!("Flush error: {}", e);
                    break;
                }
            }
            // Handle shutdown signal
            _ = &mut shutdown_rx => {
                let _ = writer.shutdown().await;
                break;
            }
        }
    }
}

// Networks with a dead IPv6 route drop our SYNs silently, so we try IPv4
// first and give each address its own timeout to reach the next one.
pub(crate) async fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    let mut addresses: Vec<_> = lookup_host((host, port))
        .await
        .map_err(|e| format!("Failed to resolve {}:{}: {}", host, port, e))?
        .collect();
    addresses.sort_by_key(|address| address.is_ipv6());
    let mut last_error = format!("No addresses found for {}:{}", host, port);
    for address in addresses {
        match timeout(ADDRESS_CONNECT_TIMEOUT, TcpStream::connect(address)).await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(e)) => last_error = format!("Failed to connect to {}: {}", address, e),
            Err(_) => {
                last_error = format!(
                    "TCP connect timed out after {}s ({})",
                    ADDRESS_CONNECT_TIMEOUT.as_secs(),
                    address
                )
            }
        }
    }
    Err(last_error)
}

pub(crate) trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncStream for T {}

// Android verifies through the system's own trust manager, so a CA the user
// installed on the phone counts; the other platforms use the OS trust store
// directly. The verifier needs the JVM once, which it keeps for the process.
#[cfg(target_os = "android")]
fn android_tls_config() -> Result<StdArc<rustls::ClientConfig>, String> {
    use jni::{objects::JObject, JavaVM};
    use rustls_platform_verifier::BuilderVerifierExt;
    use std::sync::OnceLock;

    static CONFIG: OnceLock<StdArc<rustls::ClientConfig>> = OnceLock::new();
    if let Some(config) = CONFIG.get() {
        return Ok(config.clone());
    }
    let ctx = ndk_context::android_context();
    // SAFETY: pointers come from the Android runtime and are valid for the app lifetime.
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    rustls_platform_verifier::android::init_with_env(&mut env, context)
        .map_err(|e| format!("Failed to reach the Android certificate verifier: {}", e))?;
    let config = rustls::ClientConfig::builder()
        .with_platform_verifier()
        .map_err(|e| format!("Failed to create TLS verifier: {}", e))?
        .with_no_client_auth();
    Ok(CONFIG.get_or_init(|| StdArc::new(config)).clone())
}

pub(crate) async fn tls_handshake(
    host: &str,
    tcp_stream: TcpStream,
) -> Result<Box<dyn AsyncStream>, String> {
    let timed_out = || {
        format!(
            "TLS handshake timed out after {}s ({})",
            TLS_HANDSHAKE_TIMEOUT.as_secs(),
            host
        )
    };

    #[cfg(not(target_os = "android"))]
    {
        let connector = TlsConnector::from(
            NativeTlsConnector::builder()
                .build()
                .map_err(|e| format!("Failed to create TLS connector: {}", e))?,
        );
        let tls_stream = timeout(TLS_HANDSHAKE_TIMEOUT, connector.connect(host, tcp_stream))
            .await
            .map_err(|_| timed_out())?
            .map_err(|e| format!("TLS handshake failed: {}", e))?;
        Ok(Box::new(tls_stream))
    }

    #[cfg(target_os = "android")]
    {
        let connector = TlsConnector::from(android_tls_config()?);
        let server_name = ServerName::try_from(host.to_string())
            .map_err(|_| format!("Invalid DNS name: {}", host))?;
        let tls_stream = timeout(
            TLS_HANDSHAKE_TIMEOUT,
            connector.connect(server_name, tcp_stream),
        )
        .await
        .map_err(|_| timed_out())?
        .map_err(|e| format!("TLS handshake failed: {}", e))?;
        Ok(Box::new(tls_stream))
    }
}

fn emit_event(app_handle: &tauri::AppHandle, client_id: &str, event: MessageEvent) {
    let _ = app_handle.emit(
        "tcp-message",
        ReceivedPayload {
            id: client_id.to_string(),
            event,
        },
    );
}

// A WebSocket carries one IRC line per frame. We hand each one to the page
// with the line ending the TCP path delivers, so both arrive the same way.
async fn websocket_read_task<R>(
    client_id: String,
    mut reader: R,
    app_handle: tauri::AppHandle,
    state: Arc<Mutex<HashMap<String, ConnectionHandle>>>,
) where
    R: StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let mut error = None;
    loop {
        match reader.next().await {
            Some(Ok(WsMessage::Text(text))) => {
                let mut data = text.as_bytes().to_vec();
                if !data.ends_with(b"\r\n") {
                    data.extend_from_slice(b"\r\n");
                }
                emit_event(
                    &app_handle,
                    &client_id,
                    MessageEvent {
                        message: Some(MessageData { data }),
                        error: None,
                        connected: None,
                    },
                );
            }
            Some(Ok(WsMessage::Binary(bytes))) => {
                let mut data = bytes.to_vec();
                if !data.ends_with(b"\r\n") {
                    data.extend_from_slice(b"\r\n");
                }
                emit_event(
                    &app_handle,
                    &client_id,
                    MessageEvent {
                        message: Some(MessageData { data }),
                        error: None,
                        connected: None,
                    },
                );
            }
            Some(Ok(WsMessage::Close(_))) | None => break,
            Some(Ok(_)) => continue,
            Some(Err(e)) => {
                error = Some(format!("Read error: {}", e));
                break;
            }
        }
    }
    emit_event(
        &app_handle,
        &client_id,
        MessageEvent {
            message: None,
            error,
            connected: Some(false),
        },
    );
    state.lock().await.remove(&client_id);
}

async fn websocket_write_task<W>(
    mut writer: W,
    mut write_rx: mpsc::Receiver<String>,
    mut shutdown_rx: oneshot::Receiver<()>,
) where
    W: SinkExt<WsMessage> + Unpin,
    W::Error: std::fmt::Display,
{
    loop {
        tokio::select! {
            Some(data) = write_rx.recv() => {
                // The frame itself ends the line, so a trailing CRLF goes.
                let line = data.trim_end_matches(['\r', '\n']).to_string();
                if let Err(e) = writer.send(WsMessage::text(line)).await {
                    eprintln!("WebSocket write error: {}", e);
                    break;
                }
            }
            _ = &mut shutdown_rx => {
                let _ = writer.send(WsMessage::Close(None)).await;
                let _ = writer.close().await;
                break;
            }
        }
    }
}

// The WebSocket lives here rather than in the web view, which a phone
// suspends along with every connection it holds the moment the app leaves
// the screen. Certificates are checked the same way as for a TLS socket.
async fn connect_websocket(
    client_id: String,
    address: String,
    state: Arc<Mutex<HashMap<String, ConnectionHandle>>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // A plain ws:// stream has no certificate to check, so only wss:// pays
    // for the verifier.
    #[cfg(target_os = "android")]
    let connector = if address.to_ascii_lowercase().starts_with("wss://") {
        Some(tokio_tungstenite::Connector::Rustls(android_tls_config()?))
    } else {
        None
    };
    #[cfg(not(target_os = "android"))]
    let connector = None;
    let (stream, _) = timeout(
        WEBSOCKET_CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_tls_with_config(address.as_str(), None, false, connector),
    )
    .await
    .map_err(|_| {
        format!(
            "WebSocket connect timed out after {}s ({})",
            WEBSOCKET_CONNECT_TIMEOUT.as_secs(),
            address
        )
    })?
    .map_err(|e| format!("WebSocket connect to {} failed: {}", address, e))?;
    let (writer, reader) = stream.split();

    let (write_tx, write_rx) = mpsc::channel::<String>(100);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    let client_id_read = client_id.clone();
    let app_handle_read = app_handle.clone();
    let state_read = state.clone();
    task::spawn(async move {
        websocket_read_task(client_id_read, reader, app_handle_read, state_read).await;
    });
    task::spawn(async move {
        websocket_write_task(writer, write_rx, shutdown_rx).await;
    });

    state.lock().await.insert(
        client_id.clone(),
        ConnectionHandle {
            write_tx,
            shutdown_tx: Some(shutdown_tx),
        },
    );
    emit_event(
        &app_handle,
        &client_id,
        MessageEvent {
            message: None,
            error: None,
            connected: Some(true),
        },
    );
    Ok(())
}

/// Connect to IRC server with real TCP/TLS implementation
#[tauri::command]
pub async fn connect(
    client_id: String,
    address: String,
    state: State<'_, SocketState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if address.starts_with("wss://") || address.starts_with("ws://") {
        return connect_websocket(client_id, address, state.0.clone(), app_handle).await;
    }

    // Parse the address to determine protocol and extract host:port
    let (use_tls, host, port) = parse_address(&address)?;

    let tcp_stream = connect_tcp(&host, port).await?;

    // Create channels for write operations
    let (write_tx, write_rx) = mpsc::channel::<String>(100);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    // Handle TLS if needed
    if use_tls {
        let tls_stream = tls_handshake(&host, tcp_stream).await?;
        let (reader, writer) = tokio::io::split(tls_stream);

        let client_id_read = client_id.clone();
        let app_handle_read = app_handle.clone();
        let state_clone = state.0.clone();
        task::spawn(async move {
            read_task(client_id_read, reader, app_handle_read, state_clone).await;
        });

        task::spawn(async move {
            write_task(writer, write_rx, shutdown_rx).await;
        });
    } else {
        // Plain TCP - use into_split for owned halves
        let (reader, writer) = tcp_stream.into_split();

        // Spawn read task
        let client_id_read = client_id.clone();
        let app_handle_read = app_handle.clone();
        let state_clone = state.0.clone();
        task::spawn(async move {
            read_task(client_id_read, reader, app_handle_read, state_clone).await;
        });

        // Spawn write task
        task::spawn(async move {
            write_task(writer, write_rx, shutdown_rx).await;
        });
    }

    // Store the connection handle
    let mut connections = state.0.lock().await;
    connections.insert(
        client_id.clone(),
        ConnectionHandle {
            write_tx,
            shutdown_tx: Some(shutdown_tx),
        },
    );

    // Emit connected event
    let _ = app_handle.emit(
        "tcp-message",
        ReceivedPayload {
            id: client_id,
            event: MessageEvent {
                message: None,
                error: None,
                connected: Some(true),
            },
        },
    );

    Ok(())
}

/// Parse address string to extract protocol, host, and port
pub(crate) fn parse_address(address: &str) -> Result<(bool, String, u16), String> {
    if let Some(stripped) = address.strip_prefix("ircs://") {
        let (host, port) = parse_host_port(stripped, 6697)?;
        Ok((true, host, port))
    } else if let Some(stripped) = address.strip_prefix("irc://") {
        let (host, port) = parse_host_port(stripped, 6667)?;
        Ok((false, host, port))
    } else {
        // Assume plain IRC if no protocol specified
        let (host, port) = parse_host_port(address, 6667)?;
        Ok((false, host, port))
    }
}

/// Parse host:port string with default port fallback
fn parse_host_port(host_port: &str, default_port: u16) -> Result<(String, u16), String> {
    if let Some((host, port_str)) = host_port.rsplit_once(':') {
        // Check if this is actually a valid port number
        if let Ok(port) = port_str.parse::<u16>() {
            Ok((host.to_string(), port))
        } else {
            // If port parsing fails, treat the whole thing as hostname
            Ok((host_port.to_string(), default_port))
        }
    } else {
        Ok((host_port.to_string(), default_port))
    }
}

/// Disconnect a specific client connection
#[tauri::command]
pub async fn disconnect(client_id: String, state: State<'_, SocketState>) -> Result<(), String> {
    let mut connections = state.0.lock().await;
    if let Some(mut handle) = connections.remove(&client_id) {
        // Send shutdown signal if available
        if let Some(shutdown_tx) = handle.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        Ok(())
    } else {
        Err(format!("No connection found for client_id: {}", client_id))
    }
}

/// Closes every connection, since a page that reloads loses the ids it would close them by.
pub async fn disconnect_all(state: &SocketState) {
    for (_, mut handle) in state.0.lock().await.drain() {
        if let Some(shutdown_tx) = handle.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
    }
}

/// Start listening for messages from all active connections
#[tauri::command]
pub async fn listen(
    _state: State<'_, SocketState>,
    _app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // This is a placeholder - actual listening is handled by the read tasks
    // spawned during connection
    Ok(())
}

/// Send data to a specific client connection
#[tauri::command]
pub async fn send(
    client_id: String,
    data: String,
    state: State<'_, SocketState>,
) -> Result<(), String> {
    // Extract write_tx without holding the mutex across .await
    let write_tx = {
        let connections = state.0.lock().await;
        connections
            .get(&client_id)
            .map(|handle| handle.write_tx.clone())
    };

    if let Some(write_tx) = write_tx {
        write_tx
            .send(data)
            .await
            .map_err(|e| format!("Failed to send data: {}", e))?;
        Ok(())
    } else {
        Err(format!("No connection found for client_id: {}", client_id))
    }
}
