// Displays, the island and the window side, in the mode's space: physical
// desktop pixels on Windows and X11, logical pixels from the island display's
// corner on a layer-shell compositor.

use std::time::Duration;

use tauri::{AppHandle, Monitor};

use super::logic::{self, Display, Rect};
use super::{prefs, window, Desktop, MARGIN, SIZE};
use crate::island;
use crate::platform::{self, DesktopMode};

/// Layer mode before the island's display was ever read: a common size.
const FALLBACK_DISPLAY: (f64, f64) = (1920.0, 1080.0);
/// How long a command waits for the GTK main thread to name the display.
const LAYER_DISPLAY_WAIT: Duration = Duration::from_secs(1);
/// How far below the island's top edge to look for the display it is on.
const ISLAND_PROBE_PX: f64 = 1.0;

/// Connected displays in the mode's space.
pub(super) fn displays(app: &AppHandle, d: &Desktop) -> Vec<Display> {
    if d.mode == DesktopMode::Layer {
        let (w, h) = d.inner.lock().unwrap().display.unwrap_or(FALLBACK_DISPLAY);
        let frame = Rect { x: 0.0, y: 0.0, w, h };
        return vec![Display { frame, work: frame, scale: 1.0 }];
    }
    let Ok(monitors) = app.available_monitors() else { return Vec::new() };
    monitors.iter().map(display_of).collect()
}

/// One monitor as the OS reports it, physical pixels.
fn display_of(m: &Monitor) -> Display {
    let (p, s, wa) = (m.position(), m.size(), m.work_area());
    Display {
        frame: Rect { x: p.x as f64, y: p.y as f64, w: s.width as f64, h: s.height as f64 },
        work: Rect {
            x: wa.position.x as f64,
            y: wa.position.y as f64,
            w: wa.size.width as f64,
            h: wa.size.height as f64,
        },
        scale: m.scale_factor(),
    }
}

/// The island's top-centre point and the scale there, in the mode's space.
pub(super) fn island_anchor(app: &AppHandle, d: &Desktop) -> Option<(f64, f64, f64)> {
    if d.mode == DesktopMode::Layer {
        let (w, _) = d.inner.lock().unwrap().display?;
        return Some((w / 2.0, 0.0, 1.0));
    }
    let win = island::window(app)?;
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    Some((pos.x as f64 + size.width as f64 / 2.0, pos.y as f64, scale))
}

/// The window side in the mode's space.
pub(super) fn side(app: &AppHandle, d: &Desktop) -> f64 {
    if d.mode == DesktopMode::Layer {
        return SIZE;
    }
    SIZE * window(app).and_then(|w| w.scale_factor().ok()).unwrap_or(1.0)
}

/// Asks the GTK main thread for the island's display (layer mode), and waits.
/// Never called from the main thread itself: every caller is a command that
/// runs on Tauri's async pool.
pub(super) fn refresh_layer_display(app: &AppHandle, d: &Desktop) {
    if d.mode != DesktopMode::Layer {
        return;
    }
    let (Some(island), Some(mochi)) = (island::window(app), window(app)) else { return };
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = app.run_on_main_thread(move || {
        let _ = tx.send(platform::layer_display(&island, &mochi));
    });
    if let Ok(Some(size)) = rx.recv_timeout(LAYER_DISPLAY_WAIT) {
        d.inner.lock().unwrap().display = Some(size);
    }
}

/// Island-window client coordinates (logical) to the mode's space. Linux only:
/// the Windows poll reads the cursor itself.
pub(super) fn from_island_client(app: &AppHandle, d: &Desktop, x: f64, y: f64) -> Option<(f64, f64)> {
    let island = island::window(app)?;
    let scale = island.scale_factor().unwrap_or(1.0);
    match d.mode {
        DesktopMode::Layer => {
            // The island is anchored to the top edge and centred.
            let (dw, _) = d.inner.lock().unwrap().display?;
            let iw = island.inner_size().ok()?.width as f64 / scale;
            Some(((dw - iw) / 2.0 + x, y))
        }
        DesktopMode::Window => {
            let pos = island.outer_position().ok()?;
            Some((pos.x as f64 + x * scale, pos.y as f64 + y * scale))
        }
        _ => None,
    }
}

/// Where he lands when he flies out, or `None` when his spot is on a display
/// that is no longer connected.
pub(super) fn target_spot(app: &AppHandle, d: &Desktop) -> Option<(f64, f64)> {
    let all = displays(app, d);
    match prefs::saved_spot(app) {
        Some(spot) if spot.space == d.mode.space() => logic::restore_spot((spot.x, spot.y), &all, SIZE, MARGIN),
        // Never placed, or placed under another kind of session: a fresh start
        // in the corner of the island's display.
        _ => {
            let (cx, top, _) = island_anchor(app, d)?;
            // One pixel below the island's top edge: inside its display.
            let home = logic::display_near((cx, top + ISLAND_PROBE_PX), &all)?;
            Some(logic::default_spot(&home, SIZE, MARGIN))
        }
    }
}
