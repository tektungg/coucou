// The desktop Mochi's window: created once at launch, then only placed, shown
// (or un-parked) and hidden (or parked), with the mouse rules re-derived from
// state.rs after every change.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::{poll, window, Desktop, EVENT_VISIBLE, LABEL, PARK, PARKED, SIZE};
use crate::platform::{self, DesktopMode};

/// Same rule as the settings window (lib.rs create_settings_window): created at
/// launch, never lazily, since a WebView2 window created later comes up blank.
/// It is then only placed, shown and hidden. Nothing is created where the
/// feature is off.
pub fn setup(app: &AppHandle) {
    let mode = create_for(app, platform::desktop_mode());
    crate::log::line(format!("desktop Mochi: {}", mode.as_str()));
    let desktop = Arc::new(Desktop::new(mode));
    app.manage(desktop.clone());
    // Nothing takes the mouse until he is out.
    refresh(app, &desktop);
    if mode == DesktopMode::Poll {
        poll::spawn_poll(app.clone(), desktop);
    }
}

/// Creates and prepares the window for `mode`; the mode that is left, which is
/// `Off` when either step failed.
fn create_for(app: &AppHandle, mode: DesktopMode) -> DesktopMode {
    if mode == DesktopMode::Off {
        return mode;
    }
    let Some(win) = create_window(app) else { return DesktopMode::Off };
    if platform::prepare_desktop_window(&win, mode) {
        return mode;
    }
    let _ = win.destroy();
    DesktopMode::Off
}

/// In a dev build the page is served by Vite, so the window needs the absolute
/// dev URL; a bundled build resolves it inside the app bundle.
fn page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/mochi.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("mochi.html".into())
}

fn create_window(app: &AppHandle) -> Option<WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, LABEL, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Mochi")
        .inner_size(SIZE, SIZE)
        // GTK won't size a non-resizable window below its natural size (see
        // island::apply_geometry). Windows would grow resize borders instead.
        .resizable(cfg!(target_os = "linux"))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .disable_drag_drop_handler()
        .focusable(false)
        .visible(PARK);
    if PARK {
        builder = builder.position(PARKED.0, PARKED.1);
    }
    builder
        .build()
        .map_err(|err| crate::log::line(format!("desktop Mochi window failed: {err}")))
        .ok()
}

/// Puts his top-left corner at `pos`, in the mode's space.
pub(super) fn place(app: &AppHandle, d: &Desktop, pos: (f64, f64)) {
    d.inner.lock().unwrap().pos = pos;
    let Some(win) = window(app) else { return };
    match d.mode {
        DesktopMode::Poll | DesktopMode::Window => {
            let _ = win.set_position(PhysicalPosition::new(pos.0.round() as i32, pos.1.round() as i32));
        }
        DesktopMode::Layer => {
            let _ = app.run_on_main_thread(move || platform::set_layer_margins(&win, pos.0, pos.1));
        }
        DesktopMode::Off => {}
    }
}

pub(super) fn show(app: &AppHandle, d: &Desktop, at: (f64, f64)) {
    place(app, d, at);
    d.inner.lock().unwrap().shown = true;
    if let Some(win) = window(app) {
        if !PARK {
            let _ = win.show();
        }
        let _ = win.set_always_on_top(true);
    }
    refresh(app, d);
    // The page draws only while he is on screen.
    let _ = app.emit_to(LABEL, EVENT_VISIBLE, true);
}

pub(super) fn hide(app: &AppHandle, d: &Desktop) {
    {
        let mut i = d.inner.lock().unwrap();
        i.shown = false;
        i.ground();
    }
    refresh(app, d);
    if PARK {
        place(app, d, PARKED);
    } else if let Some(win) = window(app) {
        let _ = win.hide();
    }
    let _ = app.emit_to(LABEL, EVENT_VISIBLE, false);
}

/// Re-derives the poll gate and what takes the mouse from the current state.
pub(super) fn refresh(app: &AppHandle, d: &Desktop) {
    let (active, ignore, shape) = {
        let mut i = d.inner.lock().unwrap();
        let ignore = i.click_through();
        // Left to the poll: its next tick applies the hit test afresh.
        if ignore.is_none() {
            i.ignoring = None;
        }
        (i.poll_active(), ignore, i.mouse_shape())
    };
    let Some(win) = window(app) else { return };
    match d.mode {
        DesktopMode::Poll => {
            if let Some(flag) = ignore {
                d.inner.lock().unwrap().ignoring = Some(flag);
                let _ = win.set_ignore_cursor_events(flag);
            }
            d.gate.set_active(active);
        }
        DesktopMode::Window | DesktopMode::Layer => {
            let _ = app.run_on_main_thread(move || platform::set_desktop_shape(&win, shape));
        }
        DesktopMode::Off => {}
    }
}
