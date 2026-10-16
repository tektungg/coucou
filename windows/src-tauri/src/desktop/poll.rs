// The Windows cursor poll for the desktop Mochi. It runs only while he is awake
// on the desktop or being carried (state.rs Inner::poll_active) and is parked
// on its PollGate the rest of the time, so a sleeping or hidden Mochi costs
// nothing. Each tick: the drag, or else click-through from the body hit test
// and the cursor for his eyes.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, WebviewWindow};

use super::flight::finish_drop;
use super::state::Carry;
use super::window::place;
use super::{logic, window, Desktop, EVENT_CURSOR, LABEL, SIZE, TICK_MS};
use crate::island::CursorPayload;
use crate::platform;

/// The last cursor position sent to his eyes, window-logical. Starts where no
/// cursor can be, so the first reading always goes out.
const NO_CURSOR: (f64, f64) = (f64::MIN, f64::MIN);

pub(super) fn spawn_poll(app: AppHandle, d: Arc<Desktop>) {
    std::thread::spawn(move || loop {
        d.gate.wait_until_active();
        let mut last = NO_CURSOR;
        while d.gate.is_active() {
            std::thread::sleep(Duration::from_millis(TICK_MS));
            tick(&app, &d, &mut last);
        }
    });
}

fn tick(app: &AppHandle, d: &Arc<Desktop>, last: &mut (f64, f64)) {
    let Some(win) = window(app) else { return };
    let Some(cursor) = platform::cursor_physical() else { return };
    let (carry, landed) = {
        let i = d.inner.lock().unwrap();
        (i.carry, i.landed)
    };
    if let Some(c) = carry {
        carry_tick(app, d, cursor, c);
    } else if landed {
        // Not landed: between a release and the drop being settled, nothing
        // to decide.
        hover_tick(d, &win, cursor, last);
    }
}

/// He hangs from the pointer: follow it while the button is held, and hand
/// the drop to the async pool (where the snap animation may wait) on release.
fn carry_tick(app: &AppHandle, d: &Arc<Desktop>, cursor: (f64, f64), c: Carry) {
    let pos = (cursor.0 - c.grab.0, cursor.1 - c.grab.1);
    if platform::left_button_down() {
        if pos != d.inner.lock().unwrap().pos {
            place(app, d, pos);
        }
        return;
    }
    d.inner.lock().unwrap().carry = None;
    let (app, d) = (app.clone(), d.clone());
    tauri::async_runtime::spawn(async move { finish_drop(&app, &d, pos, c.from).await });
}

/// He sits on the desktop: only his body takes the mouse, and his eyes follow
/// the cursor.
fn hover_tick(d: &Desktop, win: &WebviewWindow, cursor: (f64, f64), last: &mut (f64, f64)) {
    let Ok(origin) = win.outer_position() else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    let local = ((cursor.0 - origin.x as f64) / scale, (cursor.1 - origin.y as f64) / scale);
    let ignore = !logic::is_over_body(local, SIZE);
    let changed = {
        let mut i = d.inner.lock().unwrap();
        let changed = i.ignoring != Some(ignore);
        i.ignoring = Some(ignore);
        changed
    };
    // Outside the lock: the call goes through the event loop.
    if changed {
        let _ = win.set_ignore_cursor_events(ignore);
    }
    if logic::moved_enough(*last, local) {
        *last = local;
        // His page only: the island and Settings have no use for it, 30 times a second.
        let _ = win.emit_to(LABEL, EVENT_CURSOR, CursorPayload { x: local.0, y: local.1 });
    }
}
