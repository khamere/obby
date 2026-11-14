//! Downloads a community release's APK into the app cache, checks its
//! SHA-256 and hands it to Android's installer. Every command runs in Kotlin.

#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
#[allow(dead_code)]
struct Native<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("app-update")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    _api.register_android_plugin("world.obby.appupdate", "AppUpdatePlugin")?;
                _app.manage(Native(handle));
            }
            Ok(())
        })
        .build()
}
