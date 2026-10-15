//! Launch robustness.
//!
//! - A panic anywhere leaves its message in coucou.log. One inside the event loop
//!   (Tauri's setup among them) aborts the process with 0xc0000409 and nothing
//!   else: on 2026-10-15 a launch right after a reinstall died that way, 1 s in,
//!   and nobody could tell why.
//! - The island window is built here instead of by Tauri from tauri.conf.json
//!   (`"create": false` there). Tauri turns a failed config window into
//!   `panic!("Failed to setup app")`; here the error is logged and retried, and
//!   if the window never comes up the user gets a message box and a clean exit.
//! - A launch that finds Coucou already running says so before the
//!   single-instance plugin hands it over and exits without a word (which is
//!   what `npm run tauri dev` looks like while the installed Coucou runs).

use std::any::Any;
use std::panic::Location;
use std::time::Duration;

use tauri::{AppHandle, WebviewWindowBuilder};

use crate::{island, log, platform};

/// How many times the island window is tried before giving up, and the pause
/// between tries: about 6 s, enough for a previous Coucou's WebView2 to wind down.
pub const ISLAND_ATTEMPTS: u32 = 5;
pub const ISLAND_RETRY: Duration = Duration::from_millis(1500);

/// Logs every panic before the default hook prints it (and the process aborts,
/// when it happened inside the event loop).
pub fn install_panic_log() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::line(format!("PANIC {}", panic_summary(info.payload(), info.location())));
        default(info);
    }));
}

/// "at src/x.rs:12: message". The payload is a `&str` or a `String` for every
/// `panic!`, `expect` and `unwrap`; anything else is named as such.
pub fn panic_summary(payload: &(dyn Any + Send), location: Option<&Location<'_>>) -> String {
    let message = payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "(non-text panic payload)".to_string());
    match location {
        Some(l) => format!("at {}:{}: {message}", l.file(), l.line()),
        None => message,
    }
}

/// The names tauri-plugin-single-instance gives its mutex, window class and
/// window title on Windows (platform_impl/windows.rs, without the `semver`
/// feature, which this app doesn't enable).
pub fn instance_names(identifier: &str) -> (String, String, String) {
    (format!("{identifier}-sim"), format!("{identifier}-sic"), format!("{identifier}-siw"))
}

pub fn handoff_message(pid: u32, path: Option<&str>) -> String {
    let who = match (pid, path) {
        (0, _) => String::new(),
        (pid, Some(path)) => format!(" (pid {pid}, {path})"),
        (pid, None) => format!(" (pid {pid})"),
    };
    format!(
        "Coucou is already running{who}: this launch opens it and exits. \
         Quit it from the tray first to run this build."
    )
}

/// Before the plugin hands this launch over: say who to, on stderr (the
/// `tauri dev` terminal) and in the log.
pub fn announce_handoff(identifier: &str) {
    let (mutex, class, title) = instance_names(identifier);
    let Some((pid, path)) = platform::running_instance(&mutex, &class, &title) else {
        return;
    };
    let message = handoff_message(pid, path.as_deref());
    eprintln!("[coucou] {message}");
    log::line(message);
}

/// Builds the island window from its tauri.conf.json entry, retrying on
/// failure. False when it never came up: the caller exits.
pub fn create_island(app: &AppHandle) -> bool {
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == island::WINDOW_LABEL).cloned() else {
        log::line("island window missing from tauri.conf.json");
        return false;
    };
    let forced = forced_failures();
    for attempt in 1..=ISLAND_ATTEMPTS {
        let result = if attempt <= forced {
            Err("forced by COUCOU_FAIL_ISLAND".to_string())
        } else {
            WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build()).map(|_| ()).map_err(|e| e.to_string())
        };
        match result {
            Ok(()) if attempt == 1 => return true,
            Ok(()) => {
                log::line(format!("island webview up on attempt {attempt}/{ISLAND_ATTEMPTS}"));
                return true;
            }
            Err(err) => {
                log::line(format!("island webview failed (attempt {attempt}/{ISLAND_ATTEMPTS}): {err}"));
                if attempt < ISLAND_ATTEMPTS {
                    std::thread::sleep(ISLAND_RETRY);
                }
            }
        }
    }
    false
}

/// The island never came up: tell the user rather than vanish, then quit.
/// `AppHandle::exit` is ignored this early (still inside setup), and there is
/// nothing to clean up yet (no tray, no pollers, no hook pipe), so the process
/// exits directly.
pub fn give_up() -> ! {
    log::line("island webview never came up: exiting");
    platform::alert(
        "Coucou",
        "Coucou couldn't open its window. Wait a few seconds and start it again.\n\n\
         Details are in %LOCALAPPDATA%\\Coucou\\coucou.log.",
    );
    std::process::exit(1);
}

/// Debug builds only: `COUCOU_FAIL_ISLAND=<n>` fails the first `n` island
/// attempts, to check the retry and the give-up path without breaking WebView2.
fn forced_failures() -> u32 {
    if cfg!(debug_assertions) {
        parse_forced(std::env::var("COUCOU_FAIL_ISLAND").ok().as_deref())
    } else {
        0
    }
}

fn parse_forced(value: Option<&str>) -> u32 {
    value.and_then(|v| v.trim().parse().ok()).unwrap_or(0)
}

/// Debug builds only: `COUCOU_PANIC_AT_SETUP=1` panics inside Tauri's setup, to
/// check that the message reaches the log before the abort.
pub fn maybe_panic_probe() {
    if cfg!(debug_assertions) && std::env::var_os("COUCOU_PANIC_AT_SETUP").is_some() {
        panic!("COUCOU_PANIC_AT_SETUP probe");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_summary_reads_str_and_string_payloads() {
        let here = Location::caller();
        let s: Box<dyn Any + Send> = Box::new("boom");
        assert_eq!(panic_summary(s.as_ref(), Some(here)), format!("at {}:{}: boom", here.file(), here.line()));
        let owned: Box<dyn Any + Send> = Box::new(String::from("Failed to setup app: busy"));
        assert_eq!(panic_summary(owned.as_ref(), None), "Failed to setup app: busy");
        let other: Box<dyn Any + Send> = Box::new(42u8);
        assert_eq!(panic_summary(other.as_ref(), None), "(non-text panic payload)");
    }

    #[test]
    fn instance_names_match_the_single_instance_plugin() {
        let (mutex, class, title) = instance_names("fr.louisraille.coucou");
        assert_eq!(mutex, "fr.louisraille.coucou-sim");
        assert_eq!(class, "fr.louisraille.coucou-sic");
        assert_eq!(title, "fr.louisraille.coucou-siw");
    }

    #[test]
    fn handoff_message_names_what_it_found() {
        let full = handoff_message(42, Some(r"C:\Users\x\AppData\Local\Coucou\coucou.exe"));
        assert!(full.contains(r"(pid 42, C:\Users\x\AppData\Local\Coucou\coucou.exe)"), "{full}");
        assert!(full.contains("Quit it from the tray"));
        assert!(handoff_message(42, None).contains("(pid 42)"));
        assert!(handoff_message(0, None).starts_with("Coucou is already running:"));
    }

    #[test]
    fn forced_failures_parse_or_default_to_none() {
        assert_eq!(parse_forced(Some("3")), 3);
        assert_eq!(parse_forced(Some(" 2 ")), 2);
        assert_eq!(parse_forced(Some("lots")), 0);
        assert_eq!(parse_forced(None), 0);
    }

    #[test]
    fn retries_last_a_few_seconds_not_forever() {
        let total = ISLAND_RETRY * (ISLAND_ATTEMPTS - 1);
        assert!(total >= Duration::from_secs(4) && total <= Duration::from_secs(10), "{total:?}");
    }

    /// Tauri must not build the island itself (it would panic on failure), and
    /// create_island must find its entry.
    #[test]
    fn island_window_is_left_to_create_island() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = conf["app"]["windows"].as_array().unwrap();
        let island = windows.iter().find(|w| w["label"] == island::WINDOW_LABEL).expect("island window entry");
        assert_eq!(island["create"], false);
    }
}
