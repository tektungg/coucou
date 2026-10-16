// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the main display inside a borderless, transparent, always-on-top
// window that never takes focus.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::platform::{self, cursor_physical, left_button_down};

/// Logical size of the full window — the largest island view, like the macOS panel.
pub const PANEL_W: f64 = 720.0;
pub const PANEL_H: f64 = 320.0;
/// Logical size of the invisible strip that wakes the island when it is hidden.
pub const STRIP_W: f64 = 240.0;
pub const STRIP_H: f64 = 6.0;

pub const WINDOW_LABEL: &str = "island";

/// Margin around the island that still counts as "on the island", in logical px.
/// Wider than the macOS 6 pt because a click must never be swallowed.
const HIT_MARGIN: f64 = 14.0;

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The island shape in window-logical coordinates, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same 16 ms
/// tick as the cursor read — an IPC round trip here loses clicks.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    pub rect: Mutex<IslandRect>,
    /// Mirrors the window flag so we only call into the OS when it changes.
    ignoring: AtomicBool,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
        }
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// A display's logical origin, the key `at:<x>,<y>` preferences are matched on.
/// Names are no good for that: two monitors of the same model share one.
fn logical_origin(m: &Monitor) -> (i32, i32) {
    let scale = m.scale_factor();
    let p = m.position();
    ((p.x as f64 / scale).round() as i32, (p.y as f64 / scale).round() as i32)
}

/// The origin an `at:<x>,<y>` screen preference names, if it is one.
fn parse_at_key(pref: &str) -> Option<(i32, i32)> {
    let (x, y) = pref.strip_prefix("at:")?.split_once(',')?;
    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
}

/// One entry of the "Island lives on" list in Settings.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MonitorChoice {
    pub key: String,
    pub label: String,
}

/// The choice for a display named `name`, `w`×`h` logical px at `origin`.
fn monitor_choice(name: Option<&str>, (w, h): (f64, f64), (x, y): (i32, i32)) -> MonitorChoice {
    let name = name.filter(|n| !n.trim().is_empty()).unwrap_or("Display");
    MonitorChoice { key: format!("at:{x},{y}"), label: format!("{name} · {w}×{h} at {x},{y}") }
}

/// Every connected display, for Settings → General → Island lives on.
pub fn monitor_choices(app: &AppHandle) -> Vec<MonitorChoice> {
    let Ok(monitors) = app.available_monitors() else { return Vec::new() };
    monitors
        .iter()
        .map(|m| {
            let scale = m.scale_factor();
            let s = m.size();
            let size = ((s.width as f64 / scale).round(), (s.height as f64 / scale).round());
            monitor_choice(m.name().map(String::as_str), size, logical_origin(m))
        })
        .collect()
}

/// The display the island lives on: a chosen one (`at:<x>,<y>`), the primary
/// one, or the one under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    if let Some(origin) = parse_at_key(pref) {
        // Unplugged or rearranged since: fall back to the primary display.
        if let Some(m) = monitors.iter().find(|m| logical_origin(m) == origin) {
            return Some(m.clone());
        }
    }
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            let s = m.size();
            ScreenInfo {
                x: p.x as f64 / scale,
                y: p.y as f64 / scale,
                width: s.width as f64 / scale,
                height: s.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 },
    }
}

/// Places and sizes the window. `collapsed` picks the wake strip instead of the panel.
pub fn apply_geometry(app: &AppHandle, pref: &str, collapsed: bool) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };

    let scale = m.scale_factor();
    let mp = *m.position();
    let ms = *m.size();

    let (lw, lh) = if collapsed { (STRIP_W, STRIP_H) } else { (PANEL_W, PANEL_H) };
    let pw = (lw * scale).round().max(1.0) as u32;
    let ph = (lh * scale).round().max(1.0) as u32;
    let x = mp.x + (ms.width as i32 - pw as i32) / 2;
    let y = mp.y;

    // GTK never sizes a non-resizable window below its natural size (200 px
    // here), so on Linux the 6 px wake strip would stay a 200 px block. tao
    // re-applies the config's `resizable: false` after the first configure, so
    // this is asked every time, just before the resize. Undecorated, the window
    // still offers the user nothing to resize it by. (Found by @YossiYad, #44.)
    #[cfg(target_os = "linux")]
    let _ = win.set_resizable(true);
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_always_on_top(true);

    // Windows can still clamp or lag the resize (a display change, waking from
    // the strip): when the size did not land, say so and ask once more.
    if let Ok(got) = win.inner_size() {
        if got.width != pw || got.height != ph {
            crate::log::line(format!(
                "window size mismatch: wanted {pw}x{ph}, got {}x{} (scale {scale}, monitor {}x{})",
                got.width, got.height, ms.width, ms.height
            ));
            let _ = win.set_size(PhysicalSize::new(pw, ph));
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// A pixel ratio this close to the window's scale (relative) needs no correction.
const ZOOM_TOLERANCE: f64 = 0.02;
/// The webview zoom is kept within these bounds, whatever the ratio says.
const ZOOM_MIN: f64 = 0.25;
const ZOOM_MAX: f64 = 4.0;

/// The webview zoom that makes one CSS pixel one logical window pixel again,
/// or `None` when it already is. WebView2's `devicePixelRatio` folds in the
/// Windows text size (and can lag a display change), so it can differ from the
/// window's scale: a 720 px window then holds fewer CSS px than the island is
/// laid out for, and the expanded island is cut on both sides. Ported from
/// upstream (Louis-CFM/coucou b9b9217).
pub fn calculate_zoom_correction(current_zoom: f64, scale: f64, dpr: f64) -> Option<f64> {
    let valid = |v: f64| v.is_finite() && v > 0.0;
    if !valid(dpr) || !valid(scale) || !valid(current_zoom) {
        return None;
    }
    if (dpr - scale).abs() / scale < ZOOM_TOLERANCE {
        return None;
    }
    Some((current_zoom * (scale / dpr)).clamp(ZOOM_MIN, ZOOM_MAX))
}

/// Position, size and scale of the monitor the island lives on. Any change here
/// means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let size = m.size();
    Some((p.x, p.y, size.width, size.height, m.scale_factor().to_bits()))
}

/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_down = false;
        // Remembered across wakes so a display change while hidden is noticed the
        // moment the island comes back.
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
        // Without a cursor to read (Linux) the loop only watches the display
        // layout, and twice a second is plenty for that: waking at 60 Hz just to
        // find no cursor costs CPU for nothing.
        let (period, screen_every) = if platform::CURSOR_POLL { (16, 30) } else { (500, 1) };
        loop {
            gate.wait_until_active();
            let mut last = (f64::MIN, f64::MIN);
            let mut ticks: u32 = 0;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(period));
                // Collapsed while we slept: this tick must not touch click-through.
                if !gate.is_active() {
                    break;
                }

                // Monitors get plugged in, unplugged, rearranged and rescaled, and
                // an island pinned to coordinates that no longer exist is an island
                // nobody can reach. Checked about twice a second — the cursor poll
                // is already running, so this costs one monitor query.
                ticks = ticks.wrapping_add(1);
                if ticks % screen_every == 0 {
                    // Overlays can pop up above us without taking the
                    // foreground, so the hook alone misses them.
                    platform::raise_island();
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            crate::log::line("display layout changed — repositioning".to_string());
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                }

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let Some((cx, cy)) = cursor_physical() else { continue };
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let size = match win.inner_size() {
                    Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
                    Err(_) => (PANEL_W, PANEL_H),
                };
                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                    continue;
                }
                last = (x, y);

                // Click-through: the window only takes the mouse over the island
                // shape. A small entry margin means the flag is already off by the
                // time a moving cursor reaches a button.
                let r = *gate.rect.lock().unwrap();
                let on_island = r.w > 0.0
                    && x >= r.x - HIT_MARGIN
                    && x <= r.x + r.w + HIT_MARGIN
                    && y >= r.y - HIT_MARGIN
                    && y <= r.y + r.h + HIT_MARGIN;

                // A file being dragged has to be able to find us. WS_EX_TRANSPARENT
                // — what click-through is on Windows — hides the window from
                // WindowFromPoint, so OLE finds no drop target and shows the "no
                // drop" cursor. macOS has no such problem: AppKit delivers drags to
                // registered destinations whatever ignoresMouseEvents says. So while
                // a button is held anywhere over the panel, the whole panel takes
                // the mouse, which also makes the drop zone as forgiving as the Mac's.
                // A press may be the start of a drag: make sure the drop target is
                // ours before the file arrives.
                let down = left_button_down();
                if down && !was_down {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || platform::unblock_webview_drops(&handle));
                }
                was_down = down;

                let dragging = down
                    && x >= 0.0
                    && x <= size.0
                    && y >= 0.0
                    && y <= size.1;

                let accept = on_island || dragging;
                if gate.ignoring.load(Ordering::Relaxed) == accept {
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    let _ = win.set_ignore_cursor_events(!accept);
                }

                let _ = win.emit("cursor", CursorPayload { x, y });
            }

            // Parked because the island hid. set_collapsed told the wake strip to
            // take the mouse, but a tick already past the check above could still
            // have made the window click-through right after — and a strip the
            // mouse falls through can only be revived from the tray. This loop is
            // the only other writer, so it has the last word: the strip listens.
            if gate.collapsed.load(Ordering::Relaxed) {
                set_ignore_cursor(&app, false);
                gate.forget_ignore_state();
            }
        }
    });
}

/// Re-applies click-through after the window or the island changed shape.
///
/// With the cursor poll (Windows) the window takes the mouse again and the next
/// tick decides from the cursor. Without it (Linux) the input region is set to
/// the island itself, or to the whole wake strip while collapsed.
pub fn refresh_click_through(app: &AppHandle, gate: &PollGate) {
    if platform::CURSOR_POLL {
        set_ignore_cursor(app, false);
        gate.forget_ignore_state();
        return;
    }
    let Some(win) = window(app) else { return };
    let region = if gate.collapsed.load(Ordering::Relaxed) {
        // The wake strip itself, never "the whole window": if the window ever
        // fails to shrink to the strip, the rest of it must not swallow clicks
        // meant for whatever sits under the top of the screen.
        Some((0.0, 0.0, STRIP_W, STRIP_H))
    } else {
        let r = *gate.rect.lock().unwrap();
        if r.w <= 0.0 {
            // Nothing drawn yet: nothing takes the mouse.
            Some((0.0, 0.0, 0.0, 0.0))
        } else {
            let x0 = (r.x - HIT_MARGIN).max(0.0);
            let y0 = (r.y - HIT_MARGIN).max(0.0);
            let x1 = r.x + r.w + HIT_MARGIN;
            let y1 = r.y + r.h + HIT_MARGIN;
            Some((x0, y0, x1 - x0, y1 - y0))
        }
    };
    platform::set_input_region(&win, region);
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

#[cfg(test)]
mod zoom_tests {
    use super::*;

    #[test]
    fn no_correction_when_the_ratio_matches_the_window_scale() {
        assert_eq!(calculate_zoom_correction(1.0, 1.0, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.25, 1.25), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.0, 1.01), None, "within the tolerance");
    }

    #[test]
    fn a_mismatched_ratio_is_zoomed_back_to_the_window_scale() {
        // 100 % display, Windows text size 125 %.
        assert_eq!(calculate_zoom_correction(1.0, 1.0, 1.25), Some(0.8));
        // 125 % display with 125 % text size.
        assert_eq!(calculate_zoom_correction(1.0, 1.25, 1.5625), Some(0.8));
        // 150 % display, the webview still on 100 %.
        assert_eq!(calculate_zoom_correction(1.0, 1.5, 1.0), Some(1.5));
    }

    #[test]
    fn once_corrected_the_ratio_matches_and_nothing_more_happens() {
        let zoom = calculate_zoom_correction(1.0, 1.0, 1.25).unwrap();
        // The webview's ratio after the zoom: 1.25 × 0.8.
        assert_eq!(calculate_zoom_correction(zoom, 1.0, 1.25 * zoom), None);
    }

    #[test]
    fn the_zoom_stays_within_bounds() {
        assert_eq!(calculate_zoom_correction(1.0, 1.0, 100.0), Some(ZOOM_MIN));
        assert_eq!(calculate_zoom_correction(1.0, 100.0, 1.0), Some(ZOOM_MAX));
    }

    #[test]
    fn nonsense_inputs_change_nothing() {
        assert_eq!(calculate_zoom_correction(1.0, 0.0, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.0, -1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, f64::NAN, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.0, f64::INFINITY), None);
        assert_eq!(calculate_zoom_correction(0.0, 1.0, 1.25), None);
    }
}

#[cfg(test)]
mod display_choice_tests {
    use super::*;

    #[test]
    fn an_at_key_names_a_logical_origin() {
        assert_eq!(parse_at_key("at:0,0"), Some((0, 0)));
        assert_eq!(parse_at_key("at:-1920, 120"), Some((-1920, 120)));
    }

    #[test]
    fn anything_else_is_not_an_at_key() {
        for pref in ["primary", "cursor", "at:", "at:1", "at:a,b", "at:1,2,3", "1,2", ""] {
            assert_eq!(parse_at_key(pref), None, "{pref:?}");
        }
    }

    #[test]
    fn a_choice_is_keyed_by_origin_and_labelled_for_people() {
        let c = monitor_choice(Some("DELL U2720Q"), (2560.0, 1440.0), (-2560, 0));
        assert_eq!(c.key, "at:-2560,0");
        assert_eq!(c.label, "DELL U2720Q · 2560×1440 at -2560,0");
        assert_eq!(parse_at_key(&c.key), Some((-2560, 0)), "the key reads back");
    }

    #[test]
    fn a_display_without_a_name_is_called_display() {
        assert!(monitor_choice(None, (1920.0, 1080.0), (0, 0)).label.starts_with("Display ·"));
        assert!(monitor_choice(Some("  "), (1920.0, 1080.0), (0, 0)).label.starts_with("Display ·"));
    }
}
