// The Mac's global actions, their default keys, and what the user stored.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The command-line flag a desktop's own shortcut settings pass to us.
pub const SHORTCUT_ARG: &str = "--shortcut";

/// One global action, as on the Mac (`ShortcutAction`). The ids are the Mac's
/// raw values and are stored in settings.json: never rename one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionDef {
    pub id: &'static str,
    pub default_keys: &'static str,
    pub enabled_by_default: bool,
    /// False for the Mac actions this version cannot do yet. Their ids and
    /// defaults stay reserved so a later port lands on the same keys.
    pub ported: bool,
}

const fn action(id: &'static str, keys: &'static str, on: bool, ported: bool) -> ActionDef {
    ActionDef { id, default_keys: keys, enabled_by_default: on, ported }
}

/// Same order as `ShortcutAction.allCases`.
pub const ACTIONS: &[ActionDef] = &[
    action("toggleIsland", "Ctrl+Alt+N", false, true),
    action("openChat", "Ctrl+Alt+Space", true, true),
    action("goToAlert", "Ctrl+Alt+A", true, true),
    action("jumpToTerminal", "Ctrl+Alt+T", true, true),
    // Dragging Mochi onto a window is not in this version.
    action("attachFrontWindow", "Ctrl+Alt+F", true, false),
    action("nextPill", "Ctrl+Alt+Right", true, true),
    action("prevPill", "Ctrl+Alt+Left", true, true),
    action("muteToggle", "Ctrl+Alt+S", true, true),
    action("desktopToggle", "Ctrl+Alt+D", true, true),
    action("wardrobeToggle", "Ctrl+Alt+G", true, true),
];

pub fn find(id: &str) -> Option<&'static ActionDef> {
    ACTIONS.iter().find(|a| a.id == id)
}

/// What the user chose for one action. An action missing from settings.json
/// uses its default; `keys` empty means no key at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Binding {
    pub keys: String,
    pub enabled: bool,
}

impl Default for Binding {
    fn default() -> Self {
        Self { keys: String::new(), enabled: true }
    }
}

/// `settings.shortcuts`: only the actions the user changed.
pub type Bindings = BTreeMap<String, Binding>;

/// The binding in force for `def`: the stored one, or the default.
pub fn effective(def: &ActionDef, stored: &Bindings) -> Binding {
    stored.get(def.id).cloned().unwrap_or_else(|| Binding {
        keys: def.default_keys.to_string(),
        enabled: def.enabled_by_default,
    })
}

/// `coucou --shortcut <id>` → the action id, when it names a ported one.
pub fn from_args(args: &[String]) -> Option<&'static str> {
    let at = args.iter().position(|a| a == SHORTCUT_ARG)?;
    let def = find(args.get(at + 1)?)?;
    def.ported.then_some(def.id)
}
