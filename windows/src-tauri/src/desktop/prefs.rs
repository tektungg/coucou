// His spot in the preferences (settings.json `desktopMochi`). Only this module
// writes it: lib.rs save_settings keeps this value over whatever a page sends.

use tauri::{AppHandle, Manager};

use super::Desktop;
use crate::settings::{self, DesktopMochiPref, DesktopSpot};

/// Saves what changed about him in the preferences.
pub(super) fn remember(app: &AppHandle, change: impl FnOnce(&mut DesktopMochiPref)) {
    let Some(shared) = app.try_state::<crate::Shared>() else { return };
    let snapshot = {
        let mut s = shared.settings.lock().unwrap();
        change(&mut s.desktop_mochi);
        s.clone()
    };
    if let Err(err) = settings::save(&snapshot) {
        crate::log::line(format!("settings: could not save the desktop Mochi spot: {err}"));
    }
}

/// He sits at `pos` (the mode's space), on the desktop or not.
pub(super) fn remember_spot(app: &AppHandle, d: &Desktop, pos: (f64, f64), on_desktop: bool) {
    let space = d.mode.space().to_string();
    remember(app, |p| {
        p.on_desktop = on_desktop;
        p.spot = Some(DesktopSpot { x: pos.0, y: pos.1, space });
    });
}

/// He is home: the next launch keeps him in the island.
pub(super) fn forget_desktop(app: &AppHandle) {
    remember(app, |p| p.on_desktop = false);
}

pub(super) fn saved_spot(app: &AppHandle) -> Option<DesktopSpot> {
    let shared = app.try_state::<crate::Shared>()?;
    let spot = shared.settings.lock().unwrap().desktop_mochi.spot.clone();
    spot
}

pub(super) fn saved_on_desktop(app: &AppHandle) -> bool {
    app.try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().desktop_mochi.on_desktop)
        .unwrap_or(false)
}
