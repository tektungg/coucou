// Mochi on the desktop: his own small window, wherever the user dropped him.
// Window side of DesktopMochi.swift, plus the geometry half of
// DesktopMochiLogic.swift (logic.rs, with its tests in logic_tests.rs).
//
// Ported from upstream (Louis-CFM/coucou 64bb85e, 7a8d5e6), where it was one
// desktop.rs; split here by job:
//   * logic.rs     pure geometry (spots, drops, home zone, easing)
//   * state.rs     what he is doing, and the click-through decisions it implies
//   * window.rs    the window itself: creation, placing, showing, refresh
//   * coords.rs    displays and the island, in the mode's space
//   * flight.rs    flights and the drop
//   * prefs.rs     his spot in the preferences
//   * poll.rs      the Windows cursor poll (click-through, eyes, drag)
//   * commands.rs  what the island and mochi.html pages call
//
// The island page runs his life cycle (src/island/desktop.ts): fly out, back to
// the island for an alert, home. This module owns the window: where it is,
// which part of it takes the mouse, the flights, the drag, and the saved spot.
//
// How the window is placed depends on the system (platform::DesktopMode):
//   * Windows: anywhere, in physical desktop pixels. A cursor poll, running
//     only while he is awake on the desktop or carried, makes the window
//     click-through except over his body, feeds his eyes, and carries him
//     during a drag.
//   * Linux X11: the same coordinates; the input region is his body, and the
//     page drives the drag.
//   * Linux layer-shell: a layer surface on the island's display, placed with
//     margins in logical pixels.
//   * GNOME on Wayland: off, nothing is created.
//
// Events sent to the pages (names kept from upstream):
//   * "desktop-visible"       to mochi: bool, he is on screen (draw or not)
//   * "desktop-flight"        to mochi: "out" | "home", a flight started
//   * "desktop-cursor"        Windows: { x, y } cursor in his window, logical
//   * "desktop-mochi-dropped" to island: { from: "island" | "desktop", home }

pub mod commands;
mod coords;
mod flight;
pub mod logic;
#[cfg(test)]
mod logic_tests;
mod poll;
mod prefs;
mod state;
mod window;

use std::sync::Arc;

use tauri::{AppHandle, Manager, WebviewWindow};

pub use state::Desktop;
pub use window::setup;

/// The desktop Mochi window's label, and the page it loads (mochi.html).
pub const LABEL: &str = "mochi";

/// Side of the square window, logical pixels (DesktopMochiLogic.panelSize).
pub const SIZE: f64 = 120.0;
/// Kept between him and the edges of the work area (DesktopMochiLogic.clampMargin).
const MARGIN: f64 = 24.0;
/// To and from the island (DesktopMochi.swift: 0.45 s, ease in-out).
const FLIGHT_MS: u64 = 450;
/// Settling into his spot after a drop (0.25 s, with a little overshoot).
const SNAP_MS: u64 = 250;
/// One frame of a flight, and one tick of the cursor poll (about 60 Hz).
const TICK_MS: u64 = 16;

/// Windows never hides his window: it parks it off-screen. tao shows a hidden
/// window again with SW_SHOW, which may take the keyboard focus from whatever
/// the user is typing in each time he flies out; a window created visible
/// (shown without activation) and only ever moved never is. Same as the
/// island, which is never re-shown either.
const PARK: bool = cfg!(windows);
/// Where a parked window waits: far outside every display.
const PARKED: (f64, f64) = (-32000.0, -32000.0);

/// Event names, as the pages listen for them.
const EVENT_VISIBLE: &str = "desktop-visible";
const EVENT_FLIGHT: &str = "desktop-flight";
const EVENT_CURSOR: &str = "desktop-cursor";
const EVENT_DROPPED: &str = "desktop-mochi-dropped";

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// The shared state `setup` put in Tauri's store, for code that only has the app.
fn state(app: &AppHandle) -> Arc<Desktop> {
    app.state::<Arc<Desktop>>().inner().clone()
}
