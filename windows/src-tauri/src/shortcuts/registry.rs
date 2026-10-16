// Registration: the plugin, applying the user's bindings, handing presses to
// the island, and the report Settings shows.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcut, Shortcut, ShortcutState};

use super::actions::{ActionDef, Bindings, SHORTCUT_ARG};
use super::keys::typed_character;
use super::plan::{plan, ActionStatus, Status};
use crate::island::WINDOW_LABEL;

/// A press, to the island: the action id.
const EVENT_SHORTCUT: &str = "shortcut";
/// The wardrobe's own event, which the wardrobe view listens to.
const EVENT_WARDROBE: &str = "open-wardrobe";
/// The report after each apply, to every window.
const EVENT_STATUS: &str = "shortcuts-status";
/// The action that goes out as `open-wardrobe` instead of `shortcut`.
const WARDROBE_ACTION: &str = "wardrobeToggle";
/// What a desktop shortcut runs when this executable can't be named.
const FALLBACK_EXE: &str = "coucou";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub actions: Vec<ActionStatus>,
    /// Why nothing could be registered at all, when that is the case.
    pub blocked: Option<String>,
    /// The command a desktop's own shortcut settings can run instead:
    /// `<this executable> --shortcut <action id>`.
    pub command: String,
}

/// What is registered right now: hot-key id → action id, plus the last report.
#[derive(Default)]
pub struct Registry {
    by_id: Mutex<HashMap<u32, &'static str>>,
    report: Mutex<Vec<ActionStatus>>,
}

/// The plugin, with every press routed through `dispatch`.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let Some(registry) = app.try_state::<Registry>() else { return };
            let action = registry.by_id.lock().unwrap().get(&shortcut.id()).copied();
            if let Some(action) = action {
                dispatch(app, action);
            }
        })
        .build()
}

/// Hands an action to the island.
pub fn dispatch<R: Runtime>(app: &AppHandle<R>, action: &str) {
    crate::log::line(format!("shortcut {action}"));
    if action == WARDROBE_ACTION {
        let _ = app.emit_to(WINDOW_LABEL, EVENT_WARDROBE, ());
    } else {
        let _ = app.emit_to(WINDOW_LABEL, EVENT_SHORTCUT, action.to_string());
    }
}

/// Unregisters everything Coucou holds.
fn release<R: Runtime>(app: &AppHandle<R>) {
    if let Some(gs) = app.try_state::<GlobalShortcut<R>>() {
        if let Err(err) = gs.unregister_all() {
            crate::log::line(format!("shortcuts: unregister failed: {err}"));
        }
    }
    if let Some(registry) = app.try_state::<Registry>() {
        registry.by_id.lock().unwrap().clear();
    }
}

/// Registers the shortcuts in `stored` in place of the current ones, and
/// tells the settings window how each one went. Never fails: a shortcut that
/// can't be had is reported, not fatal.
pub fn apply<R: Runtime>(app: &AppHandle<R>, stored: &Bindings) {
    release(app);
    // The plugin isn't started where no global shortcut can work.
    let gs = match crate::platform::global_shortcuts_blocked() {
        Some(_) => None,
        None => app.try_state::<GlobalShortcut<R>>(),
    };
    let mut by_id = HashMap::new();
    let report: Vec<ActionStatus> = plan(stored, typed_character)
        .into_iter()
        .map(|(def, outcome)| match outcome {
            Err(refused) => refused,
            Ok(shortcut) => ActionStatus::new(def.id, register(gs.as_deref(), def, shortcut, &mut by_id)),
        })
        .collect();
    if let Some(registry) = app.try_state::<Registry>() {
        *registry.by_id.lock().unwrap() = by_id;
        *registry.report.lock().unwrap() = report;
    }
    let _ = app.emit(EVENT_STATUS, status(app));
}

/// Registers one planned shortcut, noting it in `by_id` when the OS took it.
fn register<R: Runtime>(
    gs: Option<&GlobalShortcut<R>>,
    def: &'static ActionDef,
    shortcut: Shortcut,
    by_id: &mut HashMap<u32, &'static str>,
) -> Status {
    let Some(gs) = gs else { return Status::Unsupported };
    // No lock of ours is held here: the plugin calls our handler with its own
    // lock taken, on the thread that registers.
    match gs.register(shortcut) {
        Ok(()) => {
            by_id.insert(shortcut.id(), def.id);
            Status::Active
        }
        Err(err) => {
            crate::log::line(format!("shortcuts: {} not registered: {err}", def.id));
            Status::InUse
        }
    }
}

/// Lets go of every shortcut while a new one is being recorded in Settings,
/// so pressing a combination Coucou already holds records it instead of
/// running it.
pub fn suspend<R: Runtime>(app: &AppHandle<R>) {
    release(app);
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> Report {
    let actions = app
        .try_state::<Registry>()
        .map(|r| r.report.lock().unwrap().clone())
        .unwrap_or_default();
    Report {
        actions,
        blocked: crate::platform::global_shortcuts_blocked().map(str::to_string),
        command: format!("{} {SHORTCUT_ARG}", launch_command()),
    }
}

/// How a desktop shortcut should start us: the AppImage when we run from one
/// (the mounted executable moves on every launch), this executable otherwise.
fn launch_command() -> String {
    let exe = std::env::var_os("APPIMAGE")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| FALLBACK_EXE.to_string());
    quote_if_spaced(exe)
}

/// A path with a space in it, quoted so a shell reads it as one word.
pub(super) fn quote_if_spaced(exe: String) -> String {
    if exe.contains(' ') {
        format!("\"{exe}\"")
    } else {
        exe
    }
}
