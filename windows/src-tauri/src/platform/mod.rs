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
