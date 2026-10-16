// What the island page (src/island/desktop.ts) and the desktop Mochi's own
// page (mochi.html) call. The async ones run on Tauri's async pool, which is
// what lets a flight wait for its animation and a layer-shell command wait on
// the GTK main thread.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalSize, State};

use super::coords::{from_island_client, island_anchor, refresh_layer_display, side, target_spot};
use super::flight::{finish_drop, fly};
use super::state::{Carry, Source};
use super::window::{hide, place, refresh, show};
use super::{logic, prefs, state, window, Desktop, EVENT_FLIGHT, FLIGHT_MS, LABEL, SIZE};
use crate::platform::{self, DesktopMode, MouseShape};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    /// "poll" | "window" | "layer" | "off".
    mode: &'static str,
    /// He was on the desktop when the app last quit.
    on_desktop: bool,
}

/// What this system can do with him, and whether he was out at the last quit.
#[tauri::command]
pub fn desktop_mochi_info(app: AppHandle, desktop: State<Arc<Desktop>>) -> DesktopInfo {
    let on_desktop = prefs::saved_on_desktop(&app) && desktop.mode != DesktopMode::Off;
    DesktopInfo { mode: desktop.mode.as_str(), on_desktop }
}

/// Dragging Mochi out of the island: the window appears under the pointer
/// (`x`, `y`: island-window client coordinates) and follows it. The cursor
/// poll carries it on Windows, `desktop_mochi_carry` elsewhere.
#[tauri::command]
pub async fn desktop_mochi_pick_up(app: AppHandle, x: f64, y: f64) -> bool {
    let d = state(&app);
    if d.mode == DesktopMode::Off || window(&app).is_none() || d.inner.lock().unwrap().shown {
        return false;
    }
    refresh_layer_display(&app, &d);
    let s = side(&app, &d);
    let center = match d.mode {
        DesktopMode::Poll => platform::cursor_physical(),
        _ => from_island_client(&app, &d, x, y),
    };
    let Some(center) = center else { return false };
    d.flight.fetch_add(1, Ordering::SeqCst);
    d.inner.lock().unwrap().carry = Some(Carry { grab: (s / 2.0, s / 2.0), from: Source::Island });
    show(&app, &d, logic::origin_for_center(center, s));
    true
}

/// Linux: the page reports the pointer during a carry out of the island.
fn page_carries(d: &Desktop) -> bool {
    d.mode != DesktopMode::Poll && d.inner.lock().unwrap().carry.is_some()
}

/// Linux: the pointer moved while Mochi is being dragged out of the island.
#[tauri::command]
pub async fn desktop_mochi_carry(app: AppHandle, x: f64, y: f64) {
    let d = state(&app);
    if !page_carries(&d) {
        return;
    }
    if let Some(c) = from_island_client(&app, &d, x, y) {
        place(&app, &d, logic::origin_for_center(c, side(&app, &d)));
    }
}

/// Linux: the button went up while Mochi was being dragged out of the island.
#[tauri::command]
pub async fn desktop_mochi_carry_end(app: AppHandle, x: f64, y: f64) {
    let d = state(&app);
    if !page_carries(&d) {
        return;
    }
    let s = side(&app, &d);
    let pos = from_island_client(&app, &d, x, y)
        .map(|c| logic::origin_for_center(c, s))
        .unwrap_or_else(|| d.inner.lock().unwrap().pos);
    finish_drop(&app, &d, pos, Source::Island).await;
}

/// The page saw a drag start on Mochi. Returns his top-left corner in the
/// mode's space, which the page needs to draw him in the overlay (layer mode).
#[tauri::command]
pub async fn desktop_mochi_drag_begin(app: AppHandle) -> Option<(f64, f64)> {
    let d = state(&app);
    let pos = d.inner.lock().unwrap().draggable_pos()?;
    // A drag takes over from a snap still settling him.
    d.flight.fetch_add(1, Ordering::SeqCst);
    match d.mode {
        DesktopMode::Poll => begin_poll_drag(&app, &d)?,
        DesktopMode::Layer => begin_layer_drag(&app, &d)?,
        _ => {}
    }
    Some(pos)
}

/// Windows: the poll carries him from here, by the point he was grabbed at.
fn begin_poll_drag(app: &AppHandle, d: &Desktop) -> Option<()> {
    let win = window(app)?;
    let (cx, cy) = platform::cursor_physical()?;
    let origin = win.outer_position().ok()?;
    let grab = (cx - origin.x as f64, cy - origin.y as f64);
    d.inner.lock().unwrap().carry = Some(Carry { grab, from: Source::Desktop });
    refresh(app, d);
    Some(())
}

/// Layer shell: the surface covers the display for the drag, so the page gets
/// exact pointer positions.
fn begin_layer_drag(app: &AppHandle, d: &Desktop) -> Option<()> {
    d.inner.lock().unwrap().overlay = true;
    let win = window(app)?;
    let _ = app.run_on_main_thread(move || {
        platform::set_layer_overlay(&win, true);
        platform::set_desktop_shape(&win, MouseShape::Whole);
    });
    Some(())
}

/// X11: the page moves the window during its drag (top-left, physical pixels).
#[tauri::command]
pub async fn desktop_mochi_drag_move(app: AppHandle, x: f64, y: f64) {
    let d = state(&app);
    if d.mode == DesktopMode::Window && d.inner.lock().unwrap().landed {
        place(&app, &d, (x, y));
    }
}

/// Linux: the page's drag ended with the top-left corner at (`x`, `y`), in the
/// mode's space. On Windows the poll sees the release itself.
#[tauri::command]
pub async fn desktop_mochi_drag_end(app: AppHandle, x: f64, y: f64) {
    let d = state(&app);
    if d.mode == DesktopMode::Poll || !d.inner.lock().unwrap().landed {
        return;
    }
    if d.mode == DesktopMode::Layer {
        end_layer_drag(&app, &d, (x, y));
    }
    place(&app, &d, (x, y));
    finish_drop(&app, &d, (x, y), Source::Desktop).await;
}

/// Layer shell: folds the drag overlay back to his own size at `at`.
fn end_layer_drag(app: &AppHandle, d: &Desktop, at: (f64, f64)) {
    d.inner.lock().unwrap().overlay = false;
    let Some(win) = window(app) else { return };
    let folded = win.clone();
    let _ = app.run_on_main_thread(move || {
        platform::set_layer_overlay(&folded, false);
        platform::set_layer_margins(&folded, at.0, at.1);
    });
    let _ = win.set_size(LogicalSize::new(SIZE, SIZE));
}

/// Launch or the end of an alert: from the island to his spot. False when the
/// spot is on a display that is gone: he then stays home, and is forgotten
/// there so the next launch doesn't try again.
#[tauri::command]
pub async fn desktop_mochi_fly_out(app: AppHandle) -> bool {
    let d = state(&app);
    if d.mode == DesktopMode::Off || window(&app).is_none() {
        return false;
    }
    refresh_layer_display(&app, &d);
    let Some(target) = target_spot(&app, &d) else {
        crate::log::line("desktop Mochi: his spot is on a display that is gone, he stays home");
        prefs::forget_desktop(&app);
        return false;
    };
    let Some((cx, top, scale)) = island_anchor(&app, &d) else { return false };
    d.inner.lock().unwrap().ground();
    show(&app, &d, logic::island_spot(cx, top, SIZE, scale));
    let _ = app.emit_to(LABEL, EVENT_FLIGHT, "out");
    if !fly(&app, &d, target, FLIGHT_MS, logic::ease_in_out).await {
        return false;
    }
    d.inner.lock().unwrap().landed = true;
    refresh(&app, &d);
    prefs::remember_spot(&app, &d, target, true);
    true
}

/// To the island, then hidden. `forget` is the user bringing him home (double
/// click, drop on the island); without it he is only away for an alert and
/// flies back out once it is answered.
#[tauri::command]
pub async fn desktop_mochi_fly_home(app: AppHandle, forget: bool) -> bool {
    let d = state(&app);
    let shown = d.inner.lock().unwrap().shown;
    let done = !shown || fly_to_island(&app, &d).await;
    if forget {
        prefs::forget_desktop(&app);
    }
    done
}

/// The flight home itself: true once he is back and hidden, false when another
/// flight took over on the way.
async fn fly_to_island(app: &AppHandle, d: &Desktop) -> bool {
    d.inner.lock().unwrap().ground();
    refresh(app, d);
    let _ = app.emit_to(LABEL, EVENT_FLIGHT, "home");
    let done = match island_anchor(app, d) {
        Some((cx, top, scale)) => fly(app, d, logic::island_spot(cx, top, SIZE, scale), FLIGHT_MS, logic::ease_in_out).await,
        None => true,
    };
    if done {
        hide(app, d);
    }
    done
}

/// The page dozed off (or woke up). Asleep, nothing polls.
#[tauri::command]
pub fn desktop_mochi_set_asleep(app: AppHandle, desktop: State<Arc<Desktop>>, asleep: bool) {
    let changed = {
        let mut i = desktop.inner.lock().unwrap();
        let changed = i.asleep != asleep;
        i.asleep = asleep;
        changed
    };
    if changed {
        refresh(&app, &desktop);
    }
}
