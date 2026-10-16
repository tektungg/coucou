// Global keyboard shortcuts: port of HotKeyCenter.swift + ShortcutLogic.swift.
//
// The shortcuts are registered from Rust through tauri-plugin-global-shortcut
// (RegisterHotKey on Windows, XGrabKey on X11). A press is handed to the island
// as a `shortcut` event carrying the action id; the island does the rest, the
// same way it handles the tray menu. The wardrobe is the exception: it goes out
// as its own `open-wardrobe` event, which the wardrobe view listens to.
//
// Default keys. The Mac uses ⌃⌥ + a letter. On Windows Ctrl+Alt *is* AltGr on
// most European layouts, so a global Ctrl+Alt+E would swallow every € typed on
// a French or German keyboard. The defaults below were checked against the
// AltGr layer of the French (AZERTY), German (QWERTZ), Spanish, Italian,
// Portuguese and Brazilian (ABNT2) layouts, which between them put a character
// on E, Q, M, W, C and on every digit and most punctuation keys:
//
//   Ctrl+Alt+Space   open the chat           Ctrl+Alt+→ / ←  next / previous pill
//   Ctrl+Alt+A       waiting permission      Ctrl+Alt+S      mute Mochi
//   Ctrl+Alt+T       open the terminal       Ctrl+Alt+G      wardrobe
//   Ctrl+Alt+D       Mochi to the desktop, or home again (the Mac's ⌃⌥D)
//   Ctrl+Alt+N       open / close the island (off by default, as on the Mac)
//
// ⌃⌥[ and ⌃⌥] became the arrows (brackets are AltGr characters almost
// everywhere) and ⌃⌥M became S (AltGr+M is µ in German). Layouts outside that
// list can still clash (Polish puts ą on AltGr+A and ś on AltGr+S), so on
// Windows every Ctrl+Alt combination is also checked against the keyboard
// layouts actually installed (platform::ctrl_alt_types) and left unregistered,
// flagged in Settings, when it types a character. The same table lives in
// src/core/shortcuts.ts; tests/shortcuts.test.mjs keeps the two in step.
//
// Ported from upstream (Louis-CFM/coucou deab632, 322e2ab), where it was one
// shortcuts.rs; split here by job:
//   * actions.rs   the Mac's actions, their defaults, what the user stored
//   * keys.rs      accelerator parsing and the AltGr check
//   * plan.rs      what each action should do before the OS is asked
//   * registry.rs  the plugin, registration, dispatch and the status report
//   * commands.rs  what the settings page calls
//
// Events sent to the pages:
//   * "shortcut"          to the island: the action id (a string)
//   * "open-wardrobe"     to the island: null, for wardrobeToggle
//   * "shortcuts-status"  to every window: the Report, after each apply

mod actions;
pub mod commands;
mod keys;
mod plan;
mod registry;
#[cfg(test)]
mod tests;

pub use actions::{from_args, Bindings};
pub use registry::{apply, dispatch, plugin, Registry};
