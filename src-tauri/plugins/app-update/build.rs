const COMMANDS: &[&str] = &[
    "start_download",
    "cancel_download",
    "download_status",
    "open_install_settings",
    "retry_install",
    "register_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
