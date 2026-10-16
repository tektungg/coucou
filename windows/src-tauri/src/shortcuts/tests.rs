// Tests of the global shortcuts. Mirrors the Mac's ShortcutLogic tests (named
// in the comments), plus what this port does on its own (the AltGr check, the
// command line, the status JSON).

use std::collections::HashSet;

use serde_json::json;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

use super::actions::{effective, find, from_args, Binding, Bindings, ACTIONS};
use super::keys::{character_vk, is_altgr_like, parse};
use super::plan::{plan, ActionStatus, Outcome, Status};
use super::registry::{quote_if_spaced, Report};

const MAC_IDS: [&str; 10] = [
    "toggleIsland", "openChat", "goToAlert", "jumpToTerminal", "attachFrontWindow",
    "nextPill", "prevPill", "muteToggle", "desktopToggle", "wardrobeToggle",
];

fn never(_: &Shortcut) -> Option<String> {
    None
}

fn bind(keys: &str, enabled: bool) -> Binding {
    Binding { keys: keys.into(), enabled }
}

/// The planned outcome of the action `id`.
fn outcome_of<'a>(planned: &'a [(&'static super::actions::ActionDef, Outcome)], id: &str) -> &'a Outcome {
    &planned.iter().find(|(d, _)| d.id == id).unwrap().1
}

fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

// testDefaultsExhaustive
#[test]
fn every_mac_action_has_a_default_and_keeps_its_id() {
    let ids: Vec<_> = ACTIONS.iter().map(|a| a.id).collect();
    assert_eq!(ids, MAC_IDS);
}

// testAllDefaultsHaveModifier
#[test]
fn every_default_parses_and_has_a_modifier() {
    for def in ACTIONS {
        let shortcut = parse(def.default_keys).unwrap_or_else(|| panic!("{} default does not parse", def.id));
        assert!(is_altgr_like(&shortcut), "{} default is not Ctrl+Alt", def.id);
    }
}

// testNoDefaultDuplicates
#[test]
fn no_two_defaults_share_a_combination() {
    let mut seen = HashSet::new();
    for def in ACTIONS {
        assert!(seen.insert(parse(def.default_keys).unwrap().id()), "{} duplicates", def.id);
    }
}

// testEnabledByDefault
#[test]
fn only_the_island_toggle_is_off_by_default() {
    for def in ACTIONS {
        assert_eq!(def.enabled_by_default, def.id != "toggleIsland", "{}", def.id);
    }
}

#[test]
fn the_action_not_ported_yet_is_reserved_not_registered() {
    for (def, outcome) in plan(&Bindings::new(), never) {
        let reserved = def.id == "attachFrontWindow";
        assert_eq!(def.ported, !reserved);
        match outcome {
            Ok(_) => assert!(def.ported && def.enabled_by_default, "{}", def.id),
            Err(s) if reserved => assert_eq!(s.status, Status::NotPorted),
            Err(s) => assert_eq!((def.id, s.status), ("toggleIsland", Status::Off)),
        }
    }
}

#[test]
fn mochi_to_the_desktop_is_ported_on_ctrl_alt_d() {
    let def = find("desktopToggle").unwrap();
    assert!(def.ported && def.enabled_by_default);
    assert_eq!(def.default_keys, "Ctrl+Alt+D");
    let planned = plan(&Bindings::new(), never);
    let shortcut = outcome_of(&planned, "desktopToggle").as_ref().unwrap();
    assert_eq!(shortcut.key, Code::KeyD);
}

#[test]
fn parsing_needs_a_modifier_and_a_known_key() {
    assert!(parse("").is_none());
    assert!(parse("A").is_none(), "a bare key would take A from every app");
    assert!(parse("Shift+A").is_none(), "so would Shift+A");
    assert!(parse("Ctrl+Escape").is_none());
    assert!(parse("Ctrl+Alt+Nope").is_none());
    assert!(parse("Ctrl+Alt").is_none());
    let s = parse("Ctrl+Alt+Space").unwrap();
    assert_eq!(s.key, Code::Space);
    assert!(s.mods.contains(Modifiers::CONTROL | Modifiers::ALT));
    assert!(!s.mods.contains(Modifiers::SHIFT));
    let all = parse("Ctrl+Alt+Shift+Super+K").unwrap();
    assert!(all.mods.contains(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER));
    // Case and spelling don't change the combination.
    assert_eq!(parse("ctrl+alt+right").unwrap().id(), parse("Control+Alt+ArrowRight").unwrap().id());
}

#[test]
fn only_ctrl_alt_without_the_windows_key_reads_as_altgr() {
    assert!(is_altgr_like(&parse("Ctrl+Alt+E").unwrap()));
    assert!(is_altgr_like(&parse("Ctrl+Alt+Shift+E").unwrap()));
    assert!(!is_altgr_like(&parse("Ctrl+Shift+E").unwrap()));
    assert!(!is_altgr_like(&parse("Ctrl+Alt+Super+E").unwrap()));
}

#[test]
fn virtual_keys_match_the_ones_registered() {
    assert_eq!(character_vk(Code::KeyA), Some(0x41));
    assert_eq!(character_vk(Code::KeyZ), Some(0x5A));
    assert_eq!(character_vk(Code::Digit0), Some(0x30));
    assert_eq!(character_vk(Code::Digit9), Some(0x39));
    assert_eq!(character_vk(Code::BracketRight), Some(0xDD));
    assert_eq!(character_vk(Code::IntlBackslash), Some(0xE2));
    assert_eq!(character_vk(Code::Space), Some(0x20));
    assert_eq!(character_vk(Code::ArrowLeft), None);
    assert_eq!(character_vk(Code::F5), None);
}

// testDuplicateDetection
#[test]
fn a_combination_used_twice_is_registered_once() {
    let mut stored = Bindings::new();
    stored.insert("jumpToTerminal".into(), bind("Ctrl+Alt+A", true));
    let planned = plan(&stored, never);
    assert!(outcome_of(&planned, "goToAlert").is_ok());
    assert_eq!(outcome_of(&planned, "jumpToTerminal").as_ref().unwrap_err().status, Status::Duplicate);

    // Same key, other modifiers: not a duplicate.
    stored.insert("jumpToTerminal".into(), bind("Ctrl+Shift+A", true));
    let planned = plan(&stored, never);
    assert!(planned.iter().all(|(d, o)| o.is_ok() || !d.ported || d.id == "toggleIsland"));

    // A disabled action doesn't hold its keys.
    stored.insert("goToAlert".into(), bind("Ctrl+Alt+A", false));
    stored.insert("jumpToTerminal".into(), bind("Ctrl+Alt+A", true));
    let planned = plan(&stored, never);
    assert!(outcome_of(&planned, "jumpToTerminal").is_ok());
}

#[test]
fn a_combination_that_types_a_character_is_not_registered() {
    let ogonek = |s: &Shortcut| (s.key == Code::KeyA).then(|| "ą".to_string());
    let planned = plan(&Bindings::new(), ogonek);
    let refused = outcome_of(&planned, "goToAlert").as_ref().unwrap_err();
    assert_eq!(refused.status, Status::TypesCharacter);
    assert_eq!(refused.typed.as_deref(), Some("ą"));
}

#[test]
fn an_unknown_combination_is_invalid() {
    let mut stored = Bindings::new();
    stored.insert("openChat".into(), bind("Ctrl+Alt+Nope", true));
    let planned = plan(&stored, never);
    assert_eq!(outcome_of(&planned, "openChat").as_ref().unwrap_err().status, Status::Invalid);
}

#[test]
fn stored_bindings_override_the_defaults_and_the_rest_fall_back() {
    let mut stored = Bindings::new();
    stored.insert("openChat".into(), bind("Ctrl+Shift+K", true));
    stored.insert("muteToggle".into(), bind("", true));
    assert_eq!(effective(find("openChat").unwrap(), &stored).keys, "Ctrl+Shift+K");
    assert_eq!(effective(find("goToAlert").unwrap(), &stored), bind("Ctrl+Alt+A", true));
    assert!(!effective(find("toggleIsland").unwrap(), &stored).enabled);
    let planned = plan(&stored, never);
    assert_eq!(outcome_of(&planned, "muteToggle").as_ref().unwrap_err().status, Status::Off);
}

// testLoadSaveRoundTrip
#[test]
fn bindings_round_trip_through_json() {
    let mut stored = Bindings::new();
    stored.insert("openChat".into(), bind("Ctrl+Alt+K", false));
    let json = serde_json::to_string(&stored).unwrap();
    assert_eq!(json, r#"{"openChat":{"keys":"Ctrl+Alt+K","enabled":false}}"#);
    assert_eq!(serde_json::from_str::<Bindings>(&json).unwrap(), stored);
    // A hand-edited entry without `enabled` stays on.
    let partial: Bindings = serde_json::from_str(r#"{"openChat":{"keys":"Ctrl+Alt+K"}}"#).unwrap();
    assert!(partial["openChat"].enabled);
}

#[test]
fn the_command_line_names_an_action() {
    assert_eq!(from_args(&args(&["coucou", "--shortcut", "openChat"])), Some("openChat"));
    assert_eq!(from_args(&args(&["coucou", "--shortcut", "wardrobeToggle"])), Some("wardrobeToggle"));
    assert_eq!(from_args(&args(&["coucou", "--shortcut"])), None);
    assert_eq!(from_args(&args(&["coucou", "--shortcut", "rm -rf"])), None);
    assert_eq!(from_args(&args(&["coucou", "--shortcut", "desktopToggle"])), Some("desktopToggle"));
    assert_eq!(from_args(&args(&["coucou", "--shortcut", "attachFrontWindow"])), None);
    assert_eq!(from_args(&args(&["coucou"])), None);
}

/// The settings page reads this shape (src/core/shortcuts.ts).
#[test]
fn the_report_is_camel_case_and_names_the_typed_character_only_when_there_is_one() {
    let typed = ActionStatus { typed: Some("€".into()), ..ActionStatus::new("goToAlert", Status::TypesCharacter) };
    let report = Report {
        actions: vec![ActionStatus::new("openChat", Status::Active), ActionStatus::new("nextPill", Status::InUse), typed],
        blocked: None,
        command: "coucou --shortcut".into(),
    };
    assert_eq!(
        serde_json::to_value(report).unwrap(),
        json!({
            "actions": [
                { "id": "openChat", "status": "active" },
                { "id": "nextPill", "status": "inUse" },
                { "id": "goToAlert", "status": "typesCharacter", "typed": "€" },
            ],
            "blocked": null,
            "command": "coucou --shortcut",
        })
    );
    let names: Vec<_> = [Status::Off, Status::Duplicate, Status::Invalid, Status::Unsupported, Status::NotPorted]
        .iter()
        .map(|s| serde_json::to_value(s).unwrap())
        .collect();
    assert_eq!(names, [json!("off"), json!("duplicate"), json!("invalid"), json!("unsupported"), json!("notPorted")]);
}

#[test]
fn a_launch_path_with_a_space_is_quoted() {
    assert_eq!(quote_if_spaced(r"C:\Program Files\Coucou\coucou.exe".into()), r#""C:\Program Files\Coucou\coucou.exe""#);
    assert_eq!(quote_if_spaced("/usr/bin/coucou".into()), "/usr/bin/coucou");
}
