// Accelerators: parsing them the way the plugin does, and telling which ones
// Windows reads as AltGr.

use std::str::FromStr;

use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

/// Windows virtual-key code of A; B to Z follow it in order.
const VK_KEY_A: u16 = 0x41;
/// Windows virtual-key code of 0; 1 to 9 follow it in order.
const VK_DIGIT_0: u16 = 0x30;

const LETTERS: [Code; 26] = {
    use Code::*;
    [
        KeyA, KeyB, KeyC, KeyD, KeyE, KeyF, KeyG, KeyH, KeyI, KeyJ, KeyK, KeyL, KeyM, KeyN, KeyO,
        KeyP, KeyQ, KeyR, KeyS, KeyT, KeyU, KeyV, KeyW, KeyX, KeyY, KeyZ,
    ]
};

const DIGITS: [Code; 10] = {
    use Code::*;
    [Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9]
};

/// The other keys that can type a character, with the virtual-key code
/// global-hotkey registers for each (VK_SPACE and the VK_OEM_* codes).
const OTHER_CHARACTER_KEYS: [(Code, u16); 13] = [
    (Code::Space, 0x20),         // VK_SPACE
    (Code::Semicolon, 0xBA),     // VK_OEM_1
    (Code::Equal, 0xBB),         // VK_OEM_PLUS
    (Code::Comma, 0xBC),         // VK_OEM_COMMA
    (Code::Minus, 0xBD),         // VK_OEM_MINUS
    (Code::Period, 0xBE),        // VK_OEM_PERIOD
    (Code::Slash, 0xBF),         // VK_OEM_2
    (Code::Backquote, 0xC0),     // VK_OEM_3
    (Code::BracketLeft, 0xDB),   // VK_OEM_4
    (Code::Backslash, 0xDC),     // VK_OEM_5
    (Code::BracketRight, 0xDD),  // VK_OEM_6
    (Code::Quote, 0xDE),         // VK_OEM_7
    (Code::IntlBackslash, 0xE2), // VK_OEM_102
];

/// Parses an accelerator the way the plugin will. `None` for an empty or
/// unknown one, and for a bare or Shift-only key: a global shortcut needs
/// Ctrl, Alt or the Windows key, or it would take that key away from every
/// other app (same rule as parseKeys in src/core/shortcuts.ts).
pub fn parse(keys: &str) -> Option<Shortcut> {
    if keys.trim().is_empty() {
        return None;
    }
    let shortcut = Shortcut::from_str(keys).ok()?;
    let has_modifier = shortcut
        .mods
        .intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER | Modifiers::META);
    (has_modifier && shortcut.key != Code::Escape).then_some(shortcut)
}

/// True when Windows reads the combination as AltGr: Ctrl and Alt held, no
/// Windows key.
pub fn is_altgr_like(shortcut: &Shortcut) -> bool {
    shortcut.mods.contains(Modifiers::CONTROL | Modifiers::ALT)
        && !shortcut.mods.intersects(Modifiers::SUPER | Modifiers::META)
}

/// The Windows virtual-key code global-hotkey registers for `code`, for the
/// keys that can type a character. Others (arrows, F-keys…) never do: `None`.
pub fn character_vk(code: Code) -> Option<u16> {
    let offset_in = |keys: &[Code], base: u16| {
        let i = keys.iter().position(|c| *c == code)?;
        u16::try_from(i).ok().map(|i| base + i)
    };
    offset_in(&LETTERS, VK_KEY_A)
        .or_else(|| offset_in(&DIGITS, VK_DIGIT_0))
        .or_else(|| OTHER_CHARACTER_KEYS.iter().find(|(c, _)| *c == code).map(|(_, vk)| *vk))
}

/// The character a Ctrl+Alt `shortcut` types on an installed layout, if any
/// (see platform::ctrl_alt_types). Other combinations never type one.
pub fn typed_character(shortcut: &Shortcut) -> Option<String> {
    if !is_altgr_like(shortcut) {
        return None;
    }
    let vk = character_vk(shortcut.key)?;
    crate::platform::ctrl_alt_types(vk, shortcut.mods.contains(Modifiers::SHIFT))
}
