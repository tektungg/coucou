// What each action should do, before the OS is asked anything, and the status
// Settings shows for it.

use std::collections::HashSet;

use serde::Serialize;
use tauri_plugin_global_shortcut::Shortcut;

use super::actions::{effective, ActionDef, Bindings, ACTIONS};
use super::keys::parse;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Registered and listening.
    Active,
    /// Turned off, or no key.
    Off,
    /// Another app already holds this combination.
    InUse,
    /// Another Coucou shortcut has the same combination.
    Duplicate,
    /// Not a combination the OS can register.
    Invalid,
    /// Ctrl+Alt+key types a character on one of the keyboard layouts.
    TypesCharacter,
    /// Global shortcuts can't be registered in this session (Wayland).
    Unsupported,
    /// The action itself isn't in this version.
    NotPorted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionStatus {
    pub id: &'static str,
    pub status: Status,
    /// The character a `TypesCharacter` combination types.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub typed: Option<String>,
}

impl ActionStatus {
    pub fn new(id: &'static str, status: Status) -> Self {
        Self { id, status, typed: None }
    }
}

/// One action's plan: the shortcut to register, or why it won't be.
pub type Outcome = Result<Shortcut, ActionStatus>;

/// What each action should do, before the OS is asked anything: the shortcut
/// to register, or the reason it won't be. `types` answers whether a Ctrl+Alt
/// combination types a character (see platform::ctrl_alt_types).
pub fn plan(
    stored: &Bindings,
    types: impl Fn(&Shortcut) -> Option<String>,
) -> Vec<(&'static ActionDef, Outcome)> {
    let mut seen = HashSet::new();
    ACTIONS.iter().map(|def| (def, outcome(def, stored, &types, &mut seen))).collect()
}

/// The plan for one action. `seen` holds the combinations already taken by
/// the actions before it: the first one keeps a combination, later ones are
/// duplicates.
fn outcome(
    def: &'static ActionDef,
    stored: &Bindings,
    types: &impl Fn(&Shortcut) -> Option<String>,
    seen: &mut HashSet<u32>,
) -> Outcome {
    let refuse = |status| Err(ActionStatus::new(def.id, status));
    let binding = effective(def, stored);
    if !def.ported {
        return refuse(Status::NotPorted);
    }
    if !binding.enabled || binding.keys.trim().is_empty() {
        return refuse(Status::Off);
    }
    let Some(shortcut) = parse(&binding.keys) else { return refuse(Status::Invalid) };
    if let Some(typed) = types(&shortcut) {
        return Err(ActionStatus { typed: Some(typed), ..ActionStatus::new(def.id, Status::TypesCharacter) });
    }
    if !seen.insert(shortcut.id()) {
        return refuse(Status::Duplicate);
    }
    Ok(shortcut)
}
