use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tauri::{Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::Message;
#[cfg(target_os = "android")]
use tokio_tungstenite::{connect_async_tls_with_config, Connector};

static APP_IN_BACKGROUND: AtomicBool = AtomicBool::new(false);
static NOTIFICATIONS_ENABLED: AtomicBool = AtomicBool::new(true);
static NEXT_NOTIFICATION_ID: AtomicI32 = AtomicI32::new(2000);
static CUSTOM_MENTIONS: OnceLock<StdMutex<Vec<String>>> = OnceLock::new();
static OWN_NICKS: OnceLock<StdMutex<Vec<String>>> = OnceLock::new();
static ACTIVE_HISTORY_BATCHES: OnceLock<StdMutex<std::collections::HashSet<String>>> =
    OnceLock::new();

fn normalize_nick(nick: &str) -> &str {
    let mut s = nick.trim().trim_start_matches(':');
    s = s.split('/').next().unwrap_or(s);
    s = s.split('@').next().unwrap_or(s);
    s = s.trim_start_matches('~');
    s = s.trim_matches(&['[', ']', '<', '>', '(', ')', '{', '}', '|', '`'][..]);

    if let Some((base, _)) = s.split_once('[') {
        if !base.is_empty() {
            s = base;
        }
    }
    if let Some((base, _)) = s.split_once('|') {
        if !base.is_empty() {
            s = base;
        }
    }

    s = s.trim_matches(&['[', ']', '<', '>', '(', ')', '{', '}', '|', '`'][..]);
    s.trim_end_matches('_')
}

#[derive(Debug, Default, Clone)]
struct ConnectionNicks {
    current: String,
    aliases: Vec<String>,
}

impl ConnectionNicks {
    fn add_alias(&mut self, candidate: &str) {
        let trimmed = candidate.trim();
        if trimmed.is_empty() || trimmed == "*" {
            return;
        }
        if !self.aliases.iter().any(|a| a.eq_ignore_ascii_case(trimmed)) {
            self.aliases.push(trimmed.to_string());
        }
        let norm = normalize_nick(trimmed);
        if !norm.is_empty() && !self.aliases.iter().any(|a| a.eq_ignore_ascii_case(norm)) {
            self.aliases.push(norm.to_string());
        }
    }

    fn set_current(&mut self, nick: &str) {
        let trimmed = nick.trim();
        if trimmed.is_empty() || trimmed == "*" {
            return;
        }
        self.current = trimmed.to_string();
        self.add_alias(trimmed);
    }
}

#[cfg(target_os = "android")]
static ANDROID_JVM: OnceLock<jni::JavaVM> = OnceLock::new();
#[cfg(target_os = "android")]
static ANDROID_ACTIVITY: OnceLock<StdMutex<Option<jni::objects::GlobalRef>>> = OnceLock::new();

fn custom_mentions_store() -> &'static StdMutex<Vec<String>> {
    CUSTOM_MENTIONS.get_or_init(|| StdMutex::new(Vec::new()))
}

fn history_batches_store() -> &'static StdMutex<std::collections::HashSet<String>> {
    ACTIVE_HISTORY_BATCHES.get_or_init(|| StdMutex::new(std::collections::HashSet::new()))
}

fn own_nicks_store() -> &'static StdMutex<Vec<String>> {
    OWN_NICKS.get_or_init(|| StdMutex::new(Vec::new()))
}

fn update_app_background_state(in_background: bool) {
    let was = APP_IN_BACKGROUND.swap(in_background, Ordering::Relaxed);
    if was != in_background {
        log::info!("[Obby] app in background: {}", in_background);
    }
}

#[cfg(target_os = "android")]
fn android_activity_store() -> &'static StdMutex<Option<jni::objects::GlobalRef>> {
    ANDROID_ACTIVITY.get_or_init(|| StdMutex::new(None))
}

#[cfg(target_os = "android")]
static MAIN_ACTIVITY_CLASS: OnceLock<jni::objects::GlobalRef> = OnceLock::new();

#[cfg(target_os = "android")]
pub fn get_android_vm() -> Option<&'static jni::JavaVM> {
    ANDROID_JVM.get()
}

#[cfg(target_os = "android")]
pub fn get_android_activity() -> Option<jni::objects::GlobalRef> {
    android_activity_store().lock().ok().and_then(|g| g.clone())
}

#[cfg(target_os = "android")]
fn show_android_notification(id: i32, title: &str, body: &str) -> bool {
    let Some(vm) = ANDROID_JVM.get() else {
        log::warn!("[Obby] show_android_notification: ANDROID_JVM is not initialized");
        return false;
    };
    let Ok(mut env) = vm.attach_current_thread() else {
        log::warn!("[Obby] show_android_notification: failed to attach thread to JVM");
        return false;
    };

    let (Ok(j_title), Ok(j_body)) = (env.new_string(title), env.new_string(body)) else {
        let _ = env.exception_clear();
        return false;
    };

    // Try via cached MAIN_ACTIVITY_CLASS first
    if let Some(class_ref) = MAIN_ACTIVITY_CLASS.get() {
        let class: &jni::objects::JClass = class_ref.as_obj().into();
        let res = env.call_static_method(
            class,
            "showIrcNotification",
            "(ILjava/lang/String;Ljava/lang/String;)Z",
            &[
                jni::objects::JValue::Int(id),
                jni::objects::JValue::Object(&j_title),
                jni::objects::JValue::Object(&j_body),
            ],
        );
        if let Ok(res_val) = res {
            if let Ok(shown) = res_val.z() {
                if shown {
                    log::info!("[Obby] showIrcNotification succeeded via MAIN_ACTIVITY_CLASS");
                    return true;
                }
                log::warn!("[Obby] showIrcNotification returned false via MAIN_ACTIVITY_CLASS");
            }
        } else {
            log::warn!(
                "[Obby] showIrcNotification via MAIN_ACTIVITY_CLASS failed: {:?}",
                res
            );
        }
        let _ = env.exception_clear();
    }

    // Fallback: try via cached activity instance's class
    if let Some(activity_ref) = get_android_activity() {
        if let Ok(class) = env.get_object_class(activity_ref.as_obj()) {
            let res = env.call_static_method(
                &class,
                "showIrcNotification",
                "(ILjava/lang/String;Ljava/lang/String;)Z",
                &[
                    jni::objects::JValue::Int(id),
                    jni::objects::JValue::Object(&j_title),
                    jni::objects::JValue::Object(&j_body),
                ],
            );
            if let Ok(res_val) = res {
                if let Ok(shown) = res_val.z() {
                    if shown {
                        log::info!("[Obby] showIrcNotification succeeded via activity_ref class");
                        return true;
                    }
                    log::warn!("[Obby] showIrcNotification returned false via activity_ref class");
                }
            } else {
                log::warn!(
                    "[Obby] showIrcNotification via activity_ref class failed: {:?}",
                    res
                );
            }
            let _ = env.exception_clear();
        }
    }

    log::warn!("[Obby] show_android_notification failed all attempts");
    false
}

#[cfg(target_os = "android")]
pub fn update_android_keepalive_status(status: &str) {
    let Some(vm) = ANDROID_JVM.get() else {
        return;
    };
    let Ok(mut env) = vm.attach_current_thread() else {
        return;
    };
    let Ok(j_status) = env.new_string(status) else {
        let _ = env.exception_clear();
        return;
    };
    if let Some(class_ref) = MAIN_ACTIVITY_CLASS.get() {
        let class: &jni::objects::JClass = class_ref.as_obj().into();
        let _ = env.call_static_method(
            class,
            "updateKeepAliveStatus",
            "(Ljava/lang/String;)V",
            &[jni::objects::JValue::Object(&j_status)],
        );
        let _ = env.exception_clear();
    }
}

pub fn dispatch_native_notification(app_handle: &tauri::AppHandle, title: String, body: String) {
    let id = NEXT_NOTIFICATION_ID.fetch_add(1, Ordering::Relaxed);
    log::info!("[Obby] dispatching notification id={}", id);
    let app = app_handle.clone();
    task::spawn_blocking(move || {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            #[cfg(target_os = "android")]
            if show_android_notification(id, &title, &body) {
                return;
            }
            use tauri_plugin_notification::NotificationExt;
            if let Err(e) = app
                .notification()
                .builder()
                .id(id)
                .title(title)
                .body(body)
                .auto_cancel()
                .show()
            {
                log::warn!("[Obby] notification plugin fallback failed: {}", e);
            }
        }));
        if let Err(panic_err) = res {
            log::error!(
                "[Obby] dispatch_native_notification panicked: {:?}",
                panic_err
            );
        }
    });
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

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

#[cfg(target_os = "android")]
#[derive(Debug)]
struct AllowAnyServerCertificate;

#[cfg(target_os = "android")]
impl rustls::client::danger::ServerCertVerifier for AllowAnyServerCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Connection handle for managing write operations and shutdown
#[derive(Debug)]
pub struct ConnectionHandle {
    write_tx: mpsc::Sender<String>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    nick: Arc<StdMutex<ConnectionNicks>>,
}

/// Socket state to manage multiple connections
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

fn strip_irc_formatting(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            0x02 | 0x0F | 0x16 | 0x1D | 0x1E | 0x1F => {
                i += 1;
            }
            0x03 => {
                i += 1;
                for _ in 0..2 {
                    if i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                if i < bytes.len() && bytes[i] == b',' {
                    i += 1;
                    for _ in 0..2 {
                        if i < bytes.len() && bytes[i].is_ascii_digit() {
                            i += 1;
                        }
                    }
                }
            }
            0x04 => {
                i += 1;
                for _ in 0..6 {
                    if i < bytes.len() && bytes[i].is_ascii_hexdigit() {
                        i += 1;
                    }
                }
                if i < bytes.len() && bytes[i] == b',' {
                    i += 1;
                    for _ in 0..6 {
                        if i < bytes.len() && bytes[i].is_ascii_hexdigit() {
                            i += 1;
                        }
                    }
                }
            }
            _ => {
                if let Some(ch) = input[i..].chars().next() {
                    out.push(ch);
                    i += ch.len_utf8();
                } else {
                    break;
                }
            }
        }
    }
    out
}

fn is_word_boundary_char(c: char) -> bool {
    !c.is_alphanumeric() && c != '_' && c != '-'
}

fn contains_whole_word_ci(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let h_lower = haystack.to_lowercase();
    let n_lower = needle.to_lowercase();
    for (idx, _) in h_lower.match_indices(&n_lower) {
        let before_ok = h_lower[..idx]
            .chars()
            .next_back()
            .map(is_word_boundary_char)
            .unwrap_or(true);
        let after_idx = idx + n_lower.len();
        let after_ok = h_lower[after_idx..]
            .chars()
            .next()
            .map(is_word_boundary_char)
            .unwrap_or(true);
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

fn is_generic_ident(ident: &str) -> bool {
    let s = ident.trim().trim_start_matches('~').to_ascii_lowercase();
    matches!(
        s.as_str(),
        "" | "*"
            | "user"
            | "u"
            | "guest"
            | "ident"
            | "android"
            | "client"
            | "chat"
            | "web"
            | "gateway"
            | "default"
            | "unknown"
            | "irc"
            | "mobile"
    )
}

fn is_self_sender(sender_nick: &str, sender_user: &str, nicks: &ConnectionNicks) -> bool {
    let check_candidate = |candidate: &str| -> bool {
        let cand_clean = candidate.trim();
        if cand_clean.is_empty() || cand_clean == "*" {
            return false;
        }
        let cand_norm = normalize_nick(cand_clean);

        let matches_val = |val: &str| -> bool {
            let val_clean = val.trim();
            if val_clean.is_empty() {
                return false;
            }
            if val_clean.eq_ignore_ascii_case(cand_clean) {
                return true;
            }
            let val_norm = normalize_nick(val_clean);
            !val_norm.is_empty()
                && (val_norm.eq_ignore_ascii_case(cand_clean)
                    || val_norm.eq_ignore_ascii_case(cand_norm)
                    || val_clean.eq_ignore_ascii_case(cand_norm))
        };

        if matches_val(sender_nick) {
            return true;
        }

        // Only match sender_user if neither sender_user nor cand_clean is a generic ident
        // and cand_clean is at least 3 characters long (e.g. bridging bots matching own nick).
        if !sender_user.is_empty()
            && !is_generic_ident(sender_user)
            && !is_generic_ident(cand_clean)
            && cand_clean.len() >= 3
            && matches_val(sender_user)
        {
            return true;
        }

        false
    };

    if check_candidate(&nicks.current) {
        return true;
    }
    if nicks.aliases.iter().any(|a| check_candidate(a)) {
        return true;
    }
    if let Ok(guard) = own_nicks_store().lock() {
        if guard.iter().any(|n| check_candidate(n)) {
            return true;
        }
    }
    false
}

fn is_relayed_self_message(body: &str, nicks: &ConnectionNicks) -> bool {
    let trimmed = body.trim_start();
    let (author_token, rest_after) = if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some((author, after)) = rest.split_once(']') {
            (Some(author), after)
        } else {
            (None, "")
        }
    } else if let Some(rest) = trimmed.strip_prefix('<') {
        if let Some((author, after)) = rest.split_once('>') {
            (Some(author), after)
        } else {
            (None, "")
        }
    } else if let Some(rest) = trimmed.strip_prefix('(') {
        if let Some((author, after)) = rest.split_once(')') {
            (Some(author), after)
        } else {
            (None, "")
        }
    } else {
        (None, "")
    };

    if rest_after.trim().is_empty() {
        return false;
    }

    if let Some(author) = author_token {
        let author_clean = author.trim();
        if !author_clean.is_empty() {
            if is_self_sender(author_clean, "", nicks) {
                return true;
            }
            if let Some(first_word) = author_clean.split_whitespace().next() {
                if !first_word.is_empty() && is_self_sender(first_word, "", nicks) {
                    return true;
                }
            }
        }
    }
    false
}

fn inspect_incoming_irc_line(
    raw_line: &str,
    write_tx: &mpsc::Sender<String>,
    nick_lock: &Arc<StdMutex<ConnectionNicks>>,
    app_handle: &tauri::AppHandle,
) {
    let line = raw_line.trim_end_matches(&['\r', '\n'][..]);
    if line.is_empty() {
        return;
    }

    let mut rest = line;
    let mut batch_id: Option<&str> = None;

    if let Some(after_at) = rest.strip_prefix('@') {
        if let Some((tags_part, remaining)) = after_at.split_once(' ') {
            rest = remaining.trim_start();
            for tag in tags_part.split(';') {
                if let Some((key, val)) = tag.split_once('=') {
                    if key == "batch" && !val.is_empty() {
                        batch_id = Some(val);
                    }
                } else if tag == "batch" {
                    batch_id = Some("");
                }
            }
        } else {
            return;
        }
    }

    let mut sender_nick = "";
    let mut sender_user = "";
    if let Some(after_colon) = rest.strip_prefix(':') {
        if let Some((source_part, remaining)) = after_colon.split_once(' ') {
            rest = remaining.trim_start();
            let (nick, rest_source) = source_part.split_once('!').unwrap_or((source_part, ""));
            sender_nick = nick;
            sender_user = rest_source
                .split('@')
                .next()
                .unwrap_or("")
                .trim_start_matches('~');
        } else {
            return;
        }
    }

    let (command, params_str) = match rest.split_once(' ') {
        Some((cmd, params)) => (cmd, params.trim_start()),
        None => (rest, ""),
    };

    if command.eq_ignore_ascii_case("PING") {
        // When backgrounded on Android, WebView JS may be paused by the OS;
        // replying PONG directly in Rust keeps the bouncer/server socket alive.
        if APP_IN_BACKGROUND.load(Ordering::Relaxed) {
            let pong = if params_str.is_empty() {
                "PONG\r\n".to_string()
            } else {
                format!("PONG {}\r\n", params_str)
            };
            let _ = write_tx.try_send(pong);
        }
        return;
    }

    if command.eq_ignore_ascii_case("BATCH") {
        let mut parts = params_str.split_whitespace();
        if let Some(ref_token) = parts.next() {
            if let Some(id) = ref_token.strip_prefix('+') {
                let batch_type = parts.next().unwrap_or("");
                if batch_type.eq_ignore_ascii_case("chathistory")
                    || batch_type.eq_ignore_ascii_case("znc.in/playback")
                    || batch_type.eq_ignore_ascii_case("soju.im/bouncer-networks")
                {
                    if let Ok(mut set) = history_batches_store().lock() {
                        set.insert(id.to_string());
                    }
                }
            } else if let Some(id) = ref_token.strip_prefix('-') {
                if let Ok(mut set) = history_batches_store().lock() {
                    set.remove(id);
                }
            }
        }
        return;
    }

    // Every standard 3-digit IRC numeric reply has the client's current nick as its first parameter.
    if command.len() == 3 && command.bytes().all(|b| b.is_ascii_digit()) {
        let target_nick = params_str.split_whitespace().next().unwrap_or("");
        if !target_nick.is_empty() && target_nick != "*" {
            if let Ok(mut n) = nick_lock.lock() {
                n.set_current(target_nick);
            }
        }
        if command == "001" {
            if let Some((_, user_host)) = params_str.split_once('!') {
                if let Some((user, _)) = user_host.split_once('@') {
                    let clean_user = user.trim_start_matches('~');
                    if !clean_user.is_empty()
                        && !is_generic_ident(clean_user)
                        && clean_user.len() >= 3
                    {
                        if let Ok(mut n) = nick_lock.lock() {
                            n.add_alias(clean_user);
                        }
                    }
                }
            }
        }
        if command == "900" {
            let mut parts = params_str.split_whitespace();
            let _ = parts.next(); // nick
            if let Some(mask) = parts.next() {
                if let Some((_, rest_mask)) = mask.split_once('!') {
                    let ident = rest_mask
                        .split('@')
                        .next()
                        .unwrap_or("")
                        .trim_start_matches('~');
                    if !ident.is_empty() && !is_generic_ident(ident) && ident.len() >= 3 {
                        if let Ok(mut n) = nick_lock.lock() {
                            n.add_alias(ident);
                        }
                    }
                }
            }
            if let Some(account) = parts.next() {
                let clean_account = account.trim();
                if !clean_account.is_empty() && clean_account != "*" {
                    if let Ok(mut n) = nick_lock.lock() {
                        n.add_alias(clean_account);
                    }
                }
            }
        }
        return;
    }

    if command.eq_ignore_ascii_case("ACCOUNT") {
        let account = params_str.trim().trim_start_matches(':');
        if !account.is_empty() && account != "*" {
            let nicks = match nick_lock.lock() {
                Ok(n) => n.clone(),
                Err(_) => ConnectionNicks::default(),
            };
            if is_self_sender(sender_nick, sender_user, &nicks) {
                if let Ok(mut n) = nick_lock.lock() {
                    n.add_alias(account);
                }
            }
        }
        return;
    }

    if command.eq_ignore_ascii_case("NICK") {
        let new_nick = params_str.trim().trim_start_matches(':');
        if !new_nick.is_empty() && !sender_nick.is_empty() {
            if let Ok(mut n) = nick_lock.lock() {
                if n.current.is_empty()
                    || sender_nick.eq_ignore_ascii_case(&n.current)
                    || n.aliases
                        .iter()
                        .any(|a| a.eq_ignore_ascii_case(sender_nick))
                {
                    n.set_current(new_nick);
                }
            }
        }
        return;
    }

    let is_privmsg_or_notice =
        command.eq_ignore_ascii_case("PRIVMSG") || command.eq_ignore_ascii_case("NOTICE");
    if !is_privmsg_or_notice {
        return;
    }

    if let Some(b_id) = batch_id {
        let is_history = b_id.is_empty()
            || history_batches_store()
                .lock()
                .map(|set| set.contains(b_id))
                .unwrap_or(false);
        if is_history {
            return;
        }
    }

    if !APP_IN_BACKGROUND.load(Ordering::Relaxed) || !NOTIFICATIONS_ENABLED.load(Ordering::Relaxed)
    {
        return;
    }

    if sender_nick.is_empty()
        || sender_nick.eq_ignore_ascii_case("HistServ")
        || sender_nick.contains('.')
        || sender_nick.starts_with('*')
    {
        return;
    }

    let nicks = match nick_lock.lock() {
        Ok(n) => n.clone(),
        Err(_) => ConnectionNicks::default(),
    };
    if is_self_sender(sender_nick, sender_user, &nicks) {
        return;
    }

    let (raw_target, after_target) = match params_str.split_once(' ') {
        Some((t, rest_msg)) => (t, rest_msg.trim_start()),
        None => return,
    };
    let target = raw_target.trim_start_matches(&['@', '+', '%', '~'][..]);
    if target.is_empty() || target == "*" {
        return;
    }
    let raw_body = after_target.strip_prefix(':').unwrap_or(after_target);

    let formatted_body = if let Some(ctcp) = raw_body.strip_prefix('\x01') {
        if let Some(action) = ctcp.strip_prefix("ACTION ") {
            format!("* {} {}", sender_nick, action.trim_end_matches('\x01'))
        } else {
            return;
        }
    } else {
        raw_body.to_string()
    };

    let clean_body = strip_irc_formatting(&formatted_body);
    if clean_body.trim().is_empty() {
        return;
    }

    if is_relayed_self_message(&clean_body, &nicks) {
        return;
    }

    let is_channel = target.starts_with('#')
        || target.starts_with('&')
        || target.starts_with('^')
        || target.starts_with('$');

    let notification_title = if !is_channel {
        Some(format!("DM from {}", sender_nick))
    } else {
        let mut mentioned = (!nicks.current.is_empty()
            && contains_whole_word_ci(&clean_body, &nicks.current))
            || nicks
                .aliases
                .iter()
                .any(|alias| !alias.is_empty() && contains_whole_word_ci(&clean_body, alias));
        if !mentioned {
            if let Ok(guard) = own_nicks_store().lock() {
                mentioned = guard
                    .iter()
                    .any(|m| !m.is_empty() && contains_whole_word_ci(&clean_body, m));
            }
        }
        if !mentioned {
            if let Ok(custom) = custom_mentions_store().lock() {
                mentioned = custom
                    .iter()
                    .any(|m| !m.is_empty() && contains_whole_word_ci(&clean_body, m));
            }
        }
        if mentioned {
            Some(format!("{} mentioned you in {}", sender_nick, target))
        } else {
            None
        }
    };

    if let Some(title) = notification_title {
        let body = if clean_body.chars().count() > 140 {
            let truncated: String = clean_body.chars().take(140).collect();
            format!("{}...", truncated)
        } else {
            clean_body
        };
        dispatch_native_notification(app_handle, title, body);
    }
}

/// Read task for handling incoming data from the socket
async fn read_task<R>(
    client_id: String,
    mut reader: R,
    app_handle: tauri::AppHandle,
    state: Arc<Mutex<HashMap<String, ConnectionHandle>>>,
    write_tx: mpsc::Sender<String>,
    nick_lock: Arc<StdMutex<ConnectionNicks>>,
) where
    R: AsyncReadExt + Unpin,
{
    let mut read_buf = vec![0u8; 4096];
    let mut line_buffer = Vec::new();
    let mut last_activity = tokio::time::Instant::now();
    let mut ping_interval = tokio::time::interval(Duration::from_secs(50));
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = ping_interval.tick() => {
                if APP_IN_BACKGROUND.load(Ordering::Relaxed) {
                    if last_activity.elapsed() >= Duration::from_secs(120) {
                        log::warn!("[Obby] read_task: keepalive timeout for client {}, disconnecting dead connection", client_id);
                        break;
                    }
                    if last_activity.elapsed() >= Duration::from_secs(50) {
                        let _ = write_tx.try_send("PING :obby-keepalive\r\n".to_string());
                    }
                }
            }
            res = reader.read(&mut read_buf) => {
                match res {
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
                        #[cfg(target_os = "android")]
                        if connections.is_empty() {
                            update_android_keepalive_status("Disconnected from IRC");
                        }
                        break;
                    }
                    Ok(n) => {
                        last_activity = tokio::time::Instant::now();
                        // Append new data to line buffer
                        line_buffer.extend_from_slice(&read_buf[..n]);

                        while let Some(pos) = line_buffer.windows(2).position(|w| w == b"\r\n") {
                            let line_data = line_buffer[..pos + 2].to_vec();
                            line_buffer.drain(..pos + 2);

                            if let Ok(line_str) = std::str::from_utf8(&line_data) {
                                inspect_incoming_irc_line(line_str, &write_tx, &nick_lock, &app_handle);
                            }

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
                        #[cfg(target_os = "android")]
                        if connections.is_empty() {
                            update_android_keepalive_status("Disconnected from IRC");
                        }
                        break;
                    }
                }
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

async fn websocket_read_task<R>(
    client_id: String,
    mut reader: R,
    app_handle: tauri::AppHandle,
    state: Arc<Mutex<HashMap<String, ConnectionHandle>>>,
    write_tx: mpsc::Sender<String>,
    nick_lock: Arc<StdMutex<ConnectionNicks>>,
) where
    R: Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let mut error = None;
    let mut last_activity = tokio::time::Instant::now();
    let mut ping_interval = tokio::time::interval(Duration::from_secs(50));
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = ping_interval.tick() => {
                if APP_IN_BACKGROUND.load(Ordering::Relaxed) {
                    if last_activity.elapsed() >= Duration::from_secs(120) {
                        log::warn!("[Obby] websocket_read_task: keepalive timeout for client {}, disconnecting dead connection", client_id);
                        error = Some("WebSocket keepalive timeout".to_string());
                        break;
                    }
                    if last_activity.elapsed() >= Duration::from_secs(50) {
                        let _ = write_tx.try_send("PING :obby-keepalive\r\n".to_string());
                    }
                }
            }
            msg = reader.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        last_activity = tokio::time::Instant::now();
                        for line in text.lines() {
                            inspect_incoming_irc_line(line, &write_tx, &nick_lock, &app_handle);
                        }
                        let _ = app_handle.emit(
                            "tcp-message",
                            ReceivedPayload {
                                id: client_id.clone(),
                                event: MessageEvent {
                                    message: Some(MessageData {
                                        data: text.as_bytes().to_vec(),
                                    }),
                                    error: None,
                                    connected: None,
                                },
                            },
                        );
                    }
                    Some(Ok(Message::Binary(data))) => {
                        last_activity = tokio::time::Instant::now();
                        if let Ok(text) = std::str::from_utf8(&data) {
                            for line in text.lines() {
                                inspect_incoming_irc_line(line, &write_tx, &nick_lock, &app_handle);
                            }
                        }
                        let _ = app_handle.emit(
                            "tcp-message",
                            ReceivedPayload {
                                id: client_id.clone(),
                                event: MessageEvent {
                                    message: Some(MessageData {
                                        data: data.to_vec(),
                                    }),
                                    error: None,
                                    connected: None,
                                },
                            },
                        );
                    }
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {
                        last_activity = tokio::time::Instant::now();
                    }
                    Some(Err(e)) => {
                        error = Some(format!("WebSocket read error: {}", e));
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    let _ = app_handle.emit(
        "tcp-message",
        ReceivedPayload {
            id: client_id.clone(),
            event: MessageEvent {
                message: None,
                error,
                connected: Some(false),
            },
        },
    );
    let mut connections = state.lock().await;
    connections.remove(&client_id);
    #[cfg(target_os = "android")]
    if connections.is_empty() {
        update_android_keepalive_status("Disconnected from IRC");
    }
}

async fn websocket_write_task<W>(
    mut writer: W,
    mut write_rx: mpsc::Receiver<String>,
    mut shutdown_rx: oneshot::Receiver<()>,
) where
    W: Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    loop {
        tokio::select! {
            Some(data) = write_rx.recv() => {
                let data_with_crlf = if data.ends_with("\r\n") {
                    data
                } else {
                    format!("{}\r\n", data)
                };

                if let Err(e) = writer.send(Message::Text(data_with_crlf.into())).await {
                    eprintln!("WebSocket write error: {}", e);
                    break;
                }
            }
            _ = &mut shutdown_rx => {
                let _ = writer.send(Message::Close(None)).await;
                break;
            }
        }
    }
}

async fn connect_websocket(
    client_id: String,
    address: String,
    state: Arc<Mutex<HashMap<String, ConnectionHandle>>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    let connection = {
        let config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AllowAnyServerCertificate))
            .with_no_client_auth();

        connect_async_tls_with_config(
            address.as_str(),
            None,
            false,
            Some(Connector::Rustls(Arc::new(config))),
        )
    };

    #[cfg(not(target_os = "android"))]
    let connection = tokio_tungstenite::connect_async(address.as_str());

    let (stream, _) = timeout(CONNECT_TIMEOUT, connection)
        .await
        .map_err(|_| {
            format!(
                "WebSocket connection timed out after {}s ({})",
                CONNECT_TIMEOUT.as_secs(),
                address
            )
        })?
        .map_err(|e| format!("WebSocket connection failed: {}", e))?;

    let (writer, reader) = stream.split();
    let (write_tx, write_rx) = mpsc::channel::<String>(100);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let nick_lock = Arc::new(StdMutex::new(ConnectionNicks::default()));
    let write_tx_read = write_tx.clone();
    let nick_lock_read = nick_lock.clone();

    state.lock().await.insert(
        client_id.clone(),
        ConnectionHandle {
            write_tx,
            shutdown_tx: Some(shutdown_tx),
            nick: nick_lock,
        },
    );
    #[cfg(target_os = "android")]
    update_android_keepalive_status("Connected to IRC");

    let _ = app_handle.emit(
        "tcp-message",
        ReceivedPayload {
            id: client_id.clone(),
            event: MessageEvent {
                message: None,
                error: None,
                connected: Some(true),
            },
        },
    );

    let client_id_read = client_id.clone();
    let app_handle_read = app_handle.clone();
    let state_read = state.clone();
    task::spawn(async move {
        websocket_read_task(
            client_id_read,
            reader,
            app_handle_read,
            state_read,
            write_tx_read,
            nick_lock_read,
        )
        .await;
    });
    task::spawn(async move {
        websocket_write_task(writer, write_rx, shutdown_rx).await;
    });

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
    if address.starts_with("ws://") || address.starts_with("wss://") {
        return connect_websocket(client_id, address, state.0.clone(), app_handle).await;
    }

    // Parse the address to determine protocol and extract host:port
    let (use_tls, host, port) = parse_address(&address)?;

    // Create TCP connection with a hard timeout so a stalled SYN/SYN-ACK
    // surfaces as a clear error instead of hanging on kernel retransmits.
    let tcp_stream = timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect(format!("{}:{}", host, port)),
    )
    .await
    .map_err(|_| {
        format!(
            "TCP connect timed out after {}s ({}:{})",
            CONNECT_TIMEOUT.as_secs(),
            host,
            port
        )
    })?
    .map_err(|e| format!("Failed to connect to {}:{}: {}", host, port, e))?;

    let _ = tcp_stream.set_nodelay(true);

    // Create channels for write operations
    let (write_tx, write_rx) = mpsc::channel::<String>(100);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let nick_lock = Arc::new(StdMutex::new(ConnectionNicks::default()));
    let write_tx_read = write_tx.clone();
    let nick_lock_read = nick_lock.clone();

    // Handle TLS if needed
    if use_tls {
        // Create TLS connection based on platform
        #[cfg(not(target_os = "android"))]
        {
            let connector = TlsConnector::from(
                NativeTlsConnector::builder()
                    .build()
                    .map_err(|e| format!("Failed to create TLS connector: {}", e))?,
            );

            let tls_stream = timeout(TLS_HANDSHAKE_TIMEOUT, connector.connect(&host, tcp_stream))
                .await
                .map_err(|_| {
                    format!(
                        "TLS handshake timed out after {}s ({})",
                        TLS_HANDSHAKE_TIMEOUT.as_secs(),
                        host
                    )
                })?
                .map_err(|e| format!("TLS handshake failed: {}", e))?;

            // Split the TLS stream using tokio::io::split
            let (reader, writer) = tokio::io::split(tls_stream);

            // Spawn read task
            let client_id_read = client_id.clone();
            let app_handle_read = app_handle.clone();
            let state_clone = state.0.clone();
            task::spawn(async move {
                read_task(
                    client_id_read,
                    reader,
                    app_handle_read,
                    state_clone,
                    write_tx_read,
                    nick_lock_read,
                )
                .await;
            });

            // Spawn write task
            task::spawn(async move {
                write_task(writer, write_rx, shutdown_rx).await;
            });
        }

        #[cfg(target_os = "android")]
        {
            // Create rustls config with webpki roots
            let root_store = rustls::RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };

            let config = rustls::ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth();

            let connector = TlsConnector::from(StdArc::new(config));

            let server_name = ServerName::try_from(host.clone())
                .map_err(|_| format!("Invalid DNS name: {}", host))?;

            let tls_stream = timeout(
                TLS_HANDSHAKE_TIMEOUT,
                connector.connect(server_name, tcp_stream),
            )
            .await
            .map_err(|_| {
                format!(
                    "TLS handshake timed out after {}s ({})",
                    TLS_HANDSHAKE_TIMEOUT.as_secs(),
                    host
                )
            })?
            .map_err(|e| format!("TLS handshake failed: {}", e))?;

            // Split the TLS stream using tokio::io::split
            let (reader, writer) = tokio::io::split(tls_stream);

            // Spawn read task
            let client_id_read = client_id.clone();
            let app_handle_read = app_handle.clone();
            let state_clone = state.0.clone();
            task::spawn(async move {
                read_task(
                    client_id_read,
                    reader,
                    app_handle_read,
                    state_clone,
                    write_tx_read,
                    nick_lock_read,
                )
                .await;
            });

            // Spawn write task
            task::spawn(async move {
                write_task(writer, write_rx, shutdown_rx).await;
            });
        }
    } else {
        // Plain TCP - use into_split for owned halves
        let (reader, writer) = tcp_stream.into_split();

        // Spawn read task
        let client_id_read = client_id.clone();
        let app_handle_read = app_handle.clone();
        let state_clone = state.0.clone();
        task::spawn(async move {
            read_task(
                client_id_read,
                reader,
                app_handle_read,
                state_clone,
                write_tx_read,
                nick_lock_read,
            )
            .await;
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
            nick: nick_lock,
        },
    );
    #[cfg(target_os = "android")]
    update_android_keepalive_status("Connected to IRC");

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
fn parse_address(address: &str) -> Result<(bool, String, u16), String> {
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
        #[cfg(target_os = "android")]
        if connections.is_empty() {
            update_android_keepalive_status("Disconnected from IRC");
        }
        Ok(())
    } else {
        Err(format!("No connection found for client_id: {}", client_id))
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
    // Extract write_tx and nick_lock without holding the mutex across .await
    let (write_tx, nick_lock) = {
        let connections = state.0.lock().await;
        match connections.get(&client_id) {
            Some(handle) => (Some(handle.write_tx.clone()), Some(handle.nick.clone())),
            None => (None, None),
        }
    };

    if let Some(nick_lock) = nick_lock {
        for line in data.lines() {
            let trimmed = line.trim();
            if trimmed.len() > 5 && trimmed[..5].eq_ignore_ascii_case("NICK ") {
                let candidate = trimmed[5..].trim().trim_start_matches(':');
                if !candidate.is_empty() {
                    if let Ok(mut n) = nick_lock.lock() {
                        if n.current.is_empty() {
                            n.set_current(candidate);
                        } else {
                            n.add_alias(candidate);
                        }
                    }
                    if let Ok(mut guard) = own_nicks_store().lock() {
                        if !guard.iter().any(|n| n.eq_ignore_ascii_case(candidate)) {
                            guard.push(candidate.to_string());
                        }
                    }
                }
            } else if trimmed.len() > 5 && trimmed[..5].eq_ignore_ascii_case("USER ") {
                let user_part = trimmed[5..].split_whitespace().next().unwrap_or("");
                if let Some(base_user) = user_part.split('/').next() {
                    if !base_user.is_empty() && !is_generic_ident(base_user) && base_user.len() >= 3
                    {
                        if let Ok(mut n) = nick_lock.lock() {
                            n.add_alias(base_user);
                        }
                        if let Ok(mut guard) = own_nicks_store().lock() {
                            if !guard.iter().any(|n| n.eq_ignore_ascii_case(base_user)) {
                                guard.push(base_user.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

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

#[tauri::command]
pub fn set_app_focused(focused: bool) {
    update_app_background_state(!focused);
}

#[tauri::command]
pub fn sync_notification_settings(
    enabled: bool,
    custom_mentions: Vec<String>,
    own_nicks: Option<Vec<String>>,
) {
    NOTIFICATIONS_ENABLED.store(enabled, Ordering::Relaxed);
    if let Ok(mut guard) = custom_mentions_store().lock() {
        *guard = custom_mentions;
    }
    if let Some(nicks) = own_nicks {
        if let Ok(mut guard) = own_nicks_store().lock() {
            *guard = nicks;
        }
    }
}

#[tauri::command]
pub fn send_native_notification(title: String, body: String, app_handle: tauri::AppHandle) {
    dispatch_native_notification(&app_handle, title, body);
}

#[cfg(target_os = "android")]
fn init_android_internal(
    env: jni::JNIEnv,
    _class: jni::objects::JClass,
    activity: jni::objects::JObject,
) {
    if let Ok(vm) = env.get_java_vm() {
        let _ = ANDROID_JVM.set(vm);
        log::info!("[Obby] ANDROID_JVM initialized via nativeInitAndroid");
    }
    if let Ok(act_class) = env.get_object_class(&activity) {
        if let Ok(class_ref) = env.new_global_ref(act_class) {
            let _ = MAIN_ACTIVITY_CLASS.set(class_ref);
            log::info!("[Obby] MAIN_ACTIVITY_CLASS cached successfully");
        }
    }
    if let Ok(global_ref) = env.new_global_ref(activity) {
        if let Ok(mut guard) = android_activity_store().lock() {
            *guard = Some(global_ref);
            log::info!("[Obby] MainActivity global ref stored");
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_obsidianirc_dev_MainActivity_nativeInitAndroid(
    env: jni::JNIEnv,
    class: jni::objects::JClass,
    activity: jni::objects::JObject,
) {
    init_android_internal(env, class, activity);
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_obsidianirc_dev_MainActivity_00024Companion_nativeInitAndroid(
    env: jni::JNIEnv,
    class: jni::objects::JClass,
    activity: jni::objects::JObject,
) {
    init_android_internal(env, class, activity);
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_obsidianirc_dev_MainActivity_nativeSetAppFocused(
    _env: jni::JNIEnv,
    _class: jni::objects::JClass,
    focused: jni::sys::jboolean,
) {
    update_app_background_state(focused == 0);
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_obsidianirc_dev_MainActivity_00024Companion_nativeSetAppFocused(
    _env: jni::JNIEnv,
    _class: jni::objects::JClass,
    focused: jni::sys::jboolean,
) {
    update_app_background_state(focused == 0);
}

#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "system" fn JNI_OnLoad(
    vm: *mut jni::sys::JavaVM,
    _reserved: *mut std::ffi::c_void,
) -> jni::sys::jint {
    if let Ok(vm_obj) = jni::JavaVM::from_raw(vm) {
        let _ = ANDROID_JVM.set(vm_obj);
    }
    jni::sys::JNI_VERSION_1_6
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_nick() {
        assert_eq!(normalize_nick("[mrkmrtns]"), "mrkmrtns");
        assert_eq!(normalize_nick("<mrkmrtns>"), "mrkmrtns");
        assert_eq!(normalize_nick("~mrkmrtns"), "mrkmrtns");
        assert_eq!(normalize_nick("mrkmrtns[m]"), "mrkmrtns");
        assert_eq!(normalize_nick("mrkmrtns|web"), "mrkmrtns");
        assert_eq!(normalize_nick("mrkmrtns_"), "mrkmrtns");
        assert_eq!(normalize_nick("mrkmrtns/libera"), "mrkmrtns");
        assert_eq!(normalize_nick("mrkmrtns@bouncer"), "mrkmrtns");
    }

    #[test]
    fn test_is_self_sender() {
        let mut nicks = ConnectionNicks::default();
        nicks.set_current("mrkmrtns");

        // Exact & normalized nick matches
        assert!(is_self_sender("mrkmrtns", "", &nicks));
        assert!(is_self_sender("[mrkmrtns]", "", &nicks));
        assert!(is_self_sender("mrkmrtns[m]", "", &nicks));
        assert!(is_self_sender("mrkmrtns_", "", &nicks));
        assert!(is_self_sender("~mrkmrtns", "", &nicks));

        // Matching on sender_user (ident)
        assert!(is_self_sender("somebot", "mrkmrtns", &nicks));
        assert!(is_self_sender("somebot", "~mrkmrtns", &nicks));

        // Non-matching
        assert!(!is_self_sender("alice", "alice", &nicks));
        assert!(!is_self_sender("mrkmrtns_imposter", "other", &nicks));

        // Generic idents must not cause false positive self-sender match
        let mut generic_nicks = ConnectionNicks::default();
        generic_nicks.set_current("mrkmrtns");
        generic_nicks.add_alias("user");
        assert!(!is_self_sender("alice", "user", &generic_nicks));
        assert!(!is_self_sender("bob", "android", &generic_nicks));
        assert!(!is_self_sender("carol", "guest", &generic_nicks));
    }

    #[test]
    fn test_is_relayed_self_message() {
        let mut nicks = ConnectionNicks::default();
        nicks.set_current("mrkmrtns");

        assert!(is_relayed_self_message("[mrkmrtns] You will!", &nicks));
        assert!(is_relayed_self_message("<mrkmrtns> You will!", &nicks));
        assert!(is_relayed_self_message("(mrkmrtns) You will!", &nicks));
        assert!(is_relayed_self_message(
            "[mrkmrtns (Discord)] You will!",
            &nicks
        ));
        assert!(is_relayed_self_message(
            "[mrkmrtns/matrix] You will!",
            &nicks
        ));

        assert!(!is_relayed_self_message("[alice] You will!", &nicks));
        assert!(!is_relayed_self_message("You will!", &nicks));
        assert!(!is_relayed_self_message("mrkmrtns: You will!", &nicks));
    }
}
