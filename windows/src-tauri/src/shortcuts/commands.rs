// What the settings page (src/settings) calls about global shortcuts.

use tauri::{AppHandle, State};

use super::registry::{self, Report};
use crate::Shared;

/// How each global shortcut went: registered, taken by another app, and so on.
#[tauri::command]
pub fn shortcuts_status(app: AppHandle) -> Report {
    registry::status(&app)
}

/// Settings is recording a new combination: let go of ours meanwhile, so the
/// keys reach the recorder instead of running an action. `false` takes them back.
#[tauri::command]
pub fn shortcuts_suspend(app: AppHandle, shared: State<Shared>, suspended: bool) {
    if suspended {
        registry::suspend(&app);
    } else {
        let stored = shared.settings.lock().unwrap().shortcuts.clone();
        registry::apply(&app, &stored);
    }
}
