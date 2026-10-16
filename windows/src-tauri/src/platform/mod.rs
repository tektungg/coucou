// Everything that differs between operating systems, behind one set of names.
//
// The rest of the app calls `platform::…` and never touches Win32 or a Linux
// API directly. Each OS file exposes the same functions; the compiler picks one.

use std::path::PathBuf;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use self::linux::*;

/// Wall-clock time in the user's time zone, for log lines and backup names.
pub struct LocalTime {
    pub year: u32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

/// A window or a monitor in physical pixels: left, top, right, bottom.
pub type Rect = (i32, i32, i32, i32);

/// Whether the foreground window is a fullscreen app (a borderless game, a
/// video or a browser in F11): it covers its whole monitor without being a
/// maximized window or having a title bar. A maximized window with an
/// auto-hidden taskbar also covers the monitor, but keeps its caption.
pub fn is_fullscreen_window(window: Rect, monitor: Rect, maximized: bool, captioned: bool) -> bool {
    let covers = window.0 <= monitor.0
        && window.1 <= monitor.1
        && window.2 >= monitor.2
        && window.3 >= monitor.3;
    covers && !maximized && !captioned && monitor.2 > monitor.0 && monitor.3 > monitor.1
}

/// The user's home directory, where `.claude/settings.json` lives.
pub fn home_dir() -> PathBuf {
    std::env::var_os(HOME_VAR)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// How the desktop Mochi's window can be placed and clicked on this system.
/// Each OS builds only its own modes (and Off).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code)]
pub enum DesktopMode {
    /// Windows: placed anywhere, and a cursor poll drives click-through, the
    /// eyes and the drag, exactly like the island.
    Poll,
    /// Linux on X11: an ordinary window the window manager lets us place; the
    /// input region is the click-through and the page drives the drag.
    Window,
    /// Linux on a layer-shell compositor (KDE, COSMIC, wlroots): a layer
    /// surface anchored to the top-left corner of the island's display, placed
    /// with margins.
    Layer,
    /// Wayland without layer-shell (GNOME): no way to put a window where the
    /// user dropped it, so Mochi stays in the island.
    Off,
}

impl DesktopMode {
    pub fn as_str(self) -> &'static str {
        match self {
            DesktopMode::Poll => "poll",
            DesktopMode::Window => "window",
            DesktopMode::Layer => "layer",
            DesktopMode::Off => "off",
        }
    }

    /// The space a saved spot is measured in. A spot from another space (the
    /// same machine once on X11, once on Wayland) is not trusted.
    pub fn space(self) -> &'static str {
        match self {
            // Physical pixels of the whole desktop, as the OS reports monitors.
            DesktopMode::Poll | DesktopMode::Window => "screen",
            // Logical pixels from the top-left corner of the island's display.
            DesktopMode::Layer | DesktopMode::Off => "layer",
        }
    }
}

/// Which part of the desktop Mochi's window takes the mouse. Windows reads
/// none of it: its poll toggles click-through from a hit test instead.
#[derive(Clone, Copy, PartialEq, Debug)]
#[cfg_attr(windows, allow(dead_code))]
pub enum MouseShape {
    /// Nothing: every click goes to what is underneath (during a flight).
    Empty,
    /// The whole window (while he is being dragged across the screen).
    Whole,
    /// A disc, in window-logical pixels: Mochi's body.
    Disc { cx: f64, cy: f64, r: f64 },
}

#[cfg(test)]
mod desktop_mode_tests {
    use super::DesktopMode;

    #[test]
    fn the_page_and_the_saved_spot_read_these_names() {
        let names: Vec<_> = [DesktopMode::Poll, DesktopMode::Window, DesktopMode::Layer, DesktopMode::Off]
            .iter()
            .map(|m| (m.as_str(), m.space()))
            .collect();
        assert_eq!(names, [("poll", "screen"), ("window", "screen"), ("layer", "layer"), ("off", "layer")]);
    }
}

#[cfg(test)]
mod fullscreen_tests {
    use super::is_fullscreen_window;

    const MONITOR: (i32, i32, i32, i32) = (0, 0, 1920, 1080);

    #[test]
    fn a_borderless_window_covering_the_monitor_is_fullscreen() {
        assert!(is_fullscreen_window(MONITOR, MONITOR, false, false));
        // Some games overshoot the monitor by a few pixels.
        assert!(is_fullscreen_window((-1, -1, 1921, 1081), MONITOR, false, false));
        // On a second monitor to the right.
        assert!(is_fullscreen_window((1920, 0, 4480, 1440), (1920, 0, 4480, 1440), false, false));
    }

    #[test]
    fn ordinary_windows_are_not() {
        // Maximized: the taskbar stays visible.
        assert!(!is_fullscreen_window((-8, -8, 1928, 1040), MONITOR, true, true));
        // Maximized with an auto-hidden taskbar covers the monitor, but is maximized and captioned.
        assert!(!is_fullscreen_window((-8, -8, 1928, 1088), MONITOR, true, true));
        // A big window with a title bar dragged over the whole screen.
        assert!(!is_fullscreen_window((0, 0, 1920, 1080), MONITOR, false, true));
        // Smaller than the monitor.
        assert!(!is_fullscreen_window((0, 0, 1280, 720), MONITOR, false, false));
        // No monitor information.
        assert!(!is_fullscreen_window((0, 0, 0, 0), (0, 0, 0, 0), false, false));
    }

    /// Live: run with a game or a fullscreen video in front, then without.
    /// `cargo test -p coucou --lib fullscreen_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn fullscreen_live() {
        println!("fullscreen_app_active = {}", super::fullscreen_app_active());
    }
}
