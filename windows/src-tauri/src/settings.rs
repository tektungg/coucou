// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// A field the file lacks takes its value from `Default`, so a settings.json
/// written by an older build still loads, whatever has been added since.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    /// Hovering the island opens it all the way, and leaving closes it at once
    /// (this build's behaviour, so on by default). Off: a hover only shows the
    /// compact island, a click opens it and Auto-close folds it.
    pub open_on_hover: bool,
    /// What Mochi wears (src/mochi/wardrobe.ts): "none" until one is picked in
    /// the wardrobe, "auto" for the seasons. Unknown values read as "none".
    pub mochi_outfit: String,
    /// The plan pills in the island header (views/plan.ts): Claude's from the
    /// Claude pill's status line files, Codex's from `codex app-server`. Off by
    /// default, so the header looks as it always has.
    pub show_plan_in_notch: bool,
    pub show_codex_plan_in_notch: bool,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat (Anthropic, and the CLI until it has its
    /// own in `chat_models`). Defaulted explicitly so a settings.json written by
    /// an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    /// Who the chat talks to: "anthropic" (API key), "claude-cli" (the Claude
    /// Code CLI on the user's own login), a cloud provider of
    /// chat/openai_compat.rs ("openai", "google", "openrouter"), or a model
    /// server of chat/local_chat.rs ("ollama", "lmstudio", "custom"). The older
    /// "api" and "cli" are read as "anthropic" and "claude-cli", anything
    /// unknown as "anthropic" (chat::provider_id).
    #[serde(default = "default_chat_provider", deserialize_with = "chat_provider_from")]
    pub chat_provider: String,
    /// The model picked for each provider other than Anthropic (whose model is
    /// `model`), by provider id.
    pub chat_models: BTreeMap<String, String>,
    /// Addresses of the model servers once connected; empty means not connected.
    pub ollama_url: String,
    pub lmstudio_url: String,
    /// Any other OpenAI-compatible server; its key, if any, is in the keychain,
    /// bound to this address.
    pub custom_url: String,
    /// CLAUDE_CONFIG_DIR handed to the CLI. Empty = Claude Code's default profile.
    #[serde(default)]
    pub claude_config_dir: String,
    /// Slack toasts never name the workspace; the Messages pill shows this.
    #[serde(default)]
    pub slack_workspace: String,
    /// Folder of the local space-timebox MCP server. Empty = space::default_dir().
    #[serde(default)]
    pub space_timebox_dir: String,
    /// Apps the Messages pill reads from Windows notifications.
    #[serde(default = "default_message_apps")]
    pub message_apps: Vec<String>,
    /// Lyrics on the Music card, from lrclib.net. On by default; off sends nothing.
    #[serde(default = "default_true")]
    pub lyrics_enabled: bool,
    /// The Music card shows Japanese, Korean and Chinese lyrics in Latin letters.
    #[serde(default)]
    pub lyrics_romanized: bool,
    /// Which one-time pill layout migration this file has had (migrate_pills).
    #[serde(default)]
    pub pill_layout: u32,
    /// Mochi on the desktop: whether he lives there, and his spot. Owned by
    /// the Rust side (desktop/prefs.rs): what a page sends back is ignored
    /// (keep_rust_owned).
    pub desktop_mochi: DesktopMochiPref,
    /// Global shortcuts the user changed, by action id; the others keep their
    /// default (see shortcuts/actions.rs).
    pub shortcuts: crate::shortcuts::Bindings,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopMochiPref {
    /// He was on the desktop when the app quit: he flies back out at launch.
    pub on_desktop: bool,
    /// Top-left corner of his window where the user last left him.
    pub spot: Option<DesktopSpot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopSpot {
    pub x: f64,
    pub y: f64,
    /// What x and y are measured in (`DesktopMode::space`).
    pub space: String,
}

/// The settings a page saves, with the values only Rust may change taken from
/// `current`: where Mochi sits on the desktop is desktop/'s to say, and a page
/// holding an older copy must not move him back. Ported from upstream
/// (Louis-CFM/coucou 64bb85e).
pub fn keep_rust_owned(mut incoming: Settings, current: &Settings) -> Settings {
    incoming.desktop_mochi = current.desktop_mochi.clone();
    incoming
}

/// The pill layout this build ships: Shelf took the Claude usage pill's
/// place and Audio joined (Claude usage stays available in Settings).
pub const PILL_LAYOUT: u32 = 1;

/// Pills that can be on at once (the header dots and the carousel fit six).
pub const MAX_ACTIVE: usize = 6;

/// Moves an older settings.json to the current pill layout, once: the
/// Claude usage pill gives its place to Shelf, and Audio is added. True when
/// something changed (the caller saves, so it never runs twice).
pub(crate) fn migrate_pills(settings: &mut Settings) -> bool {
    if settings.pill_layout >= PILL_LAYOUT {
        return false;
    }
    let active = &mut settings.active_integrations;
    if let Some(i) = active.iter().position(|id| id == "integration_quota") {
        if active.iter().any(|id| id == "integration_shelf") {
            active.remove(i);
        } else {
            active[i] = "integration_shelf".into();
        }
    } else if !active.iter().any(|id| id == "integration_shelf") {
        active.push("integration_shelf".into());
    }
    if !active.iter().any(|id| id == "integration_audio") {
        active.push("integration_audio".into());
    }
    active.truncate(MAX_ACTIVE);
    settings.pill_layout = PILL_LAYOUT;
    true
}

fn default_true() -> bool {
    true
}

/// The stock integrations this build hides (Claude Code covers them). GitHub
/// is back since its pulse card was ported; it stays off until switched on.
pub const HIDDEN_INTEGRATIONS: &[&str] = &[
    "integration_resend", "integration_n8n", "integration_vercel",
    "integration_notion", "integration_calcom", "integration_stripe",
];

/// This build's own pills, on by default.
pub const PERSONAL_INTEGRATIONS: &[&str] = &[
    "integration_space", "integration_media", "integration_messages", "integration_shelf", "integration_audio",
];

fn default_model() -> String {
    crate::chat::claude::DEFAULT_MODEL.to_string()
}

fn default_message_apps() -> Vec<String> {
    ["discord", "slack", "telegram", "whatsapp"].iter().map(|s| s.to_string()).collect()
}

fn personal_defaults() -> Vec<String> {
    PERSONAL_INTEGRATIONS.iter().map(|s| s.to_string()).collect()
}

/// Drops the hidden stock pills. A list of stock pills only (the defaults every
/// older settings.json carries: hidden ones, maybe GitHub) becomes this build's
/// own set, so an upgrade lands on working pills instead of none. GitHub alone,
/// switched on here, is kept.
fn migrate_integrations(active: &[String]) -> Vec<String> {
    let hidden = |id: &String| HIDDEN_INTEGRATIONS.contains(&id.as_str());
    let ours = |id: &String| !hidden(id) && id != "integration_github";
    let stock_file = active.iter().any(hidden) && !active.iter().any(ours);
    if stock_file {
        return personal_defaults();
    }
    active.iter().filter(|id| !hidden(id)).cloned().collect()
}

fn default_chat_provider() -> String {
    crate::chat::ANTHROPIC.into()
}

/// A stored or saved provider id, in this build's ids. Both settings.json and
/// a page's save go through it, so an older value never sticks around.
fn chat_provider_from<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let stored = String::deserialize(deserializer)?;
    Ok(crate::chat::provider_id(&stored))
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            open_on_hover: true,
            show_plan_in_notch: false,
            show_codex_plan_in_notch: false,
            mochi_outfit: "none".into(),
            absence_interval: 180.0,
            active_integrations: personal_defaults(),
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            chat_provider: default_chat_provider(),
            chat_models: BTreeMap::new(),
            ollama_url: String::new(),
            lmstudio_url: String::new(),
            custom_url: String::new(),
            claude_config_dir: String::new(),
            slack_workspace: String::new(),
            space_timebox_dir: String::new(),
            message_apps: default_message_apps(),
            lyrics_enabled: true,
            lyrics_romanized: false,
            pill_layout: PILL_LAYOUT,
            desktop_mochi: DesktopMochiPref::default(),
            shortcuts: Default::default(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

/// The preferences on disk. A corrupt or unreadable settings.json gives the
/// defaults but is never lost (prefs_file.rs).
pub fn load() -> Settings {
    let mut settings: Settings = crate::prefs_file::load_from(&settings_path());
    settings.active_integrations = migrate_integrations(&settings.active_integrations);
    if migrate_pills(&mut settings) {
        // Saved at once: a migration that ran on every start would bring back
        // a pill the user later switched off.
        if let Err(err) = save(&settings) {
            crate::log::line(format!("settings: could not save the pill migration: {err}"));
        }
    }
    settings
}

/// Writes the preferences whole (temporary file, then rename).
pub fn save(settings: &Settings) -> std::io::Result<()> {
    crate::platform::ensure_private_dir(&config_dir())?;
    crate::prefs_file::save_to(&settings_path(), settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_stock_pills_give_way_to_this_builds_own() {
        // What every older settings.json carries: only stock pills.
        let old = ids(&["integration_resend", "integration_n8n", "integration_vercel", "integration_github"]);
        assert_eq!(migrate_integrations(&old), personal_defaults());
        // A list already mixed keeps the personal ones and drops the rest.
        let mixed = ids(&["integration_vercel", "integration_space", "integration_media"]);
        assert_eq!(migrate_integrations(&mixed), ids(&["integration_space", "integration_media"]));
        // GitHub is no longer hidden: someone who switches it on keeps it,
        // with this build's pills or alone.
        let github = ids(&["integration_github", "integration_space"]);
        assert_eq!(migrate_integrations(&github), github);
        assert_eq!(migrate_integrations(&ids(&["integration_github"])), ids(&["integration_github"]));
        // An opt-in pill of this build next to a stock one is kept too.
        let quota = ids(&["integration_quota", "integration_vercel"]);
        assert_eq!(migrate_integrations(&quota), ids(&["integration_quota"]));
        // Someone who switched everything off stays switched off.
        assert!(migrate_integrations(&[]).is_empty());
    }

    #[test]
    fn older_settings_get_the_new_preferences_by_default() {
        let old = r#"{"soundEnabled":true,"soundVolume":0.1,"autoCloseInterval":15,
            "absenceInterval":180,"activeIntegrations":[],"screen":"primary",
            "autostart":false,"hooksInstalled":true}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert_eq!(s.slack_workspace, "");
        assert_eq!(s.space_timebox_dir, "");
        assert_eq!(s.message_apps, default_message_apps());
        assert!(s.lyrics_enabled);
        assert!(!s.lyrics_romanized);
        assert!(s.open_on_hover, "this build always opened on hover");
        assert_eq!(s.mochi_outfit, "none", "Mochi keeps his look until an outfit is chosen");
    }

    fn with(active: &[&str], layout: u32) -> Settings {
        Settings { active_integrations: ids(active), pill_layout: layout, ..Settings::default() }
    }

    #[test]
    fn shelf_takes_the_claude_usage_place_and_audio_joins() {
        let mut s = with(&["integration_quota", "integration_space", "integration_media", "integration_messages"], 0);
        assert!(migrate_pills(&mut s));
        assert_eq!(
            s.active_integrations,
            ids(&["integration_shelf", "integration_space", "integration_media", "integration_messages", "integration_audio"])
        );
        assert_eq!(s.pill_layout, PILL_LAYOUT);
        // Once only: a pill switched off afterwards stays off.
        s.active_integrations.retain(|id| id != "integration_audio");
        assert!(!migrate_pills(&mut s));
        assert!(!s.active_integrations.contains(&"integration_audio".to_string()));
    }

    #[test]
    fn migration_without_claude_usage_still_adds_both() {
        let mut s = with(&["integration_space"], 0);
        assert!(migrate_pills(&mut s));
        assert_eq!(s.active_integrations, ids(&["integration_space", "integration_shelf", "integration_audio"]));
        // Already there: not duplicated, and the cap holds.
        let mut s = with(&["integration_quota", "integration_shelf", "a", "b", "c", "d"], 0);
        assert!(migrate_pills(&mut s));
        assert_eq!(s.active_integrations.len(), MAX_ACTIVE);
        assert_eq!(s.active_integrations.iter().filter(|id| *id == "integration_shelf").count(), 1);
        assert!(!s.active_integrations.contains(&"integration_quota".to_string()));
    }

    #[test]
    fn a_fresh_install_needs_no_migration() {
        let mut s = Settings::default();
        assert!(!migrate_pills(&mut s));
        assert!(s.active_integrations.contains(&"integration_shelf".to_string()));
        assert!(!s.active_integrations.contains(&"integration_quota".to_string()));
        assert!(s.active_integrations.len() <= MAX_ACTIVE);
    }

    #[test]
    fn lyrics_can_be_switched_off() {
        let json = serde_json::to_value(Settings { lyrics_enabled: false, ..Settings::default() }).unwrap();
        assert_eq!(json["lyricsEnabled"], false);
        let back: Settings = serde_json::from_value(json).unwrap();
        assert!(!back.lyrics_enabled);
    }

    /// One bad value (hand-edited, or from a bug) must not cost every other
    /// preference: this build's own fields survive it.
    #[test]
    fn a_bad_field_keeps_this_builds_other_preferences() {
        let file = r#"{"soundVolume":"loud","messageApps":["discord"],"lyricsEnabled":false,
            "spaceTimeboxDir":"D:\\mcp\\timebox","chatProvider":"cli"}"#;
        let s: Settings = crate::prefs_file::parse(file.as_bytes()).expect("salvaged, not thrown away");
        assert_eq!(s.sound_volume, Settings::default().sound_volume);
        assert_eq!(s.message_apps, vec!["discord".to_string()]);
        assert!(!s.lyrics_enabled);
        assert_eq!(s.space_timebox_dir, r"D:\mcp\timebox");
        assert_eq!(s.chat_provider, "claude-cli");
    }

    #[test]
    fn a_file_from_before_the_desktop_mochi_keeps_him_in_the_island() {
        let old = r#"{"soundEnabled":true,"model":"some-model","mochiOutfit":"witchHat"}"#;
        let s: Settings = crate::prefs_file::parse(old.as_bytes()).unwrap();
        assert_eq!(s.desktop_mochi, DesktopMochiPref::default());
        assert!(!s.desktop_mochi.on_desktop);
        assert_eq!(s.mochi_outfit, "witchHat");
    }

    #[test]
    fn the_plan_pills_stay_off_until_turned_on_and_round_trip() {
        let old: Settings = crate::prefs_file::parse(br#"{"model":"some-model"}"#).unwrap();
        assert!(!old.show_plan_in_notch && !old.show_codex_plan_in_notch);
        let on = Settings { show_plan_in_notch: true, ..Settings::default() };
        let json = serde_json::to_value(&on).unwrap();
        assert_eq!(json["showPlanInNotch"], true);
        assert_eq!(json["showCodexPlanInNotch"], false);
        let back: Settings = serde_json::from_value(json).unwrap();
        assert!(back.show_plan_in_notch);
    }

    #[test]
    fn a_half_written_desktop_spot_costs_only_the_spot() {
        let file = r#"{"model":"some-model","desktopMochi":{"onDesktop":true,"spot":{"x":"left"}}}"#;
        let s: Settings = crate::prefs_file::parse(file.as_bytes()).expect("salvaged, not thrown away");
        // The whole field falls back, and nothing else does.
        assert_eq!(s.desktop_mochi, DesktopMochiPref::default());
        assert_eq!(s.model, "some-model");

        let s: Settings = crate::prefs_file::parse(br#"{"desktopMochi":{"onDesktop":true}}"#).unwrap();
        assert!(s.desktop_mochi.on_desktop);
        assert_eq!(s.desktop_mochi.spot, None);
    }

    #[test]
    fn the_desktop_spot_is_written_in_camel_case_and_reads_back() {
        let spot = DesktopSpot { x: 1500.5, y: -300.0, space: "screen".into() };
        let pref = DesktopMochiPref { on_desktop: true, spot: Some(spot) };
        let json = serde_json::to_value(Settings { desktop_mochi: pref.clone(), ..Settings::default() }).unwrap();
        assert_eq!(
            json["desktopMochi"],
            serde_json::json!({ "onDesktop": true, "spot": { "x": 1500.5, "y": -300.0, "space": "screen" } })
        );
        let back: Settings = serde_json::from_value(json).unwrap();
        assert_eq!(back.desktop_mochi, pref);
    }

    #[test]
    fn a_page_saving_its_settings_never_moves_mochi() {
        let spot = DesktopSpot { x: 10.0, y: 20.0, space: "screen".into() };
        let current = Settings {
            desktop_mochi: DesktopMochiPref { on_desktop: true, spot: Some(spot) },
            ..Settings::default()
        };
        // The page's copy is stale (he was in the island when it loaded) and
        // it changed a real preference.
        let incoming = Settings { sound_enabled: false, ..Settings::default() };
        let saved = keep_rust_owned(incoming, &current);
        assert_eq!(saved.desktop_mochi, current.desktop_mochi);
        assert!(!saved.sound_enabled, "the page's own change is kept");
    }

    #[test]
    fn shortcuts_are_written_in_camel_case_and_read_back() {
        let file = r#"{"model":"some-model","shortcuts":{"openChat":{"keys":"Ctrl+Shift+K","enabled":false}}}"#;
        let s: Settings = crate::prefs_file::parse(file.as_bytes()).unwrap();
        let chat = &s.shortcuts["openChat"];
        assert_eq!((chat.keys.as_str(), chat.enabled), ("Ctrl+Shift+K", false));
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["shortcuts"], serde_json::json!({ "openChat": { "keys": "Ctrl+Shift+K", "enabled": false } }));
        // A file from before the shortcuts: every action keeps its default.
        let old: Settings = crate::prefs_file::parse(br#"{"model":"some-model"}"#).unwrap();
        assert!(old.shortcuts.is_empty());
    }

    /// Ported from upstream (deab632): a bad shortcuts value is dropped on
    /// its own, every other preference survives it.
    #[test]
    fn a_bad_shortcuts_field_costs_only_the_shortcuts() {
        let file = r#"{"model":"some-model","lyricsEnabled":false,"shortcuts":"Ctrl+Alt+A"}"#;
        let s: Settings = crate::prefs_file::parse(file.as_bytes()).expect("salvaged, not thrown away");
        assert!(s.shortcuts.is_empty());
        assert_eq!(s.model, "some-model");
        assert!(!s.lyrics_enabled);
    }

    /// A settings.json written before the CLI chat existed must still load,
    /// and keep chatting through the API key it was set up with.
    #[test]
    fn older_settings_default_to_the_api_chat() {
        let old = r#"{"soundEnabled":true,"soundVolume":0.1,"autoCloseInterval":15,
            "absenceInterval":180,"activeIntegrations":[],"screen":"primary",
            "autostart":false,"hooksInstalled":true,"model":"claude-sonnet-5"}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert_eq!(s.chat_provider, "anthropic");
        assert_eq!(s.claude_config_dir, "");
        assert_eq!(s.model, "claude-sonnet-5");
        assert!(s.chat_models.is_empty());
        assert_eq!((s.ollama_url.as_str(), s.lmstudio_url.as_str(), s.custom_url.as_str()), ("", "", ""));
    }

    /// The CLI-era values move to this build's provider ids on load, and so
    /// does what a page still holding them saves.
    #[test]
    fn older_chat_provider_values_are_migrated() {
        let read = |value: serde_json::Value| -> Settings {
            let file = serde_json::json!({ "model": "some-model", "chatProvider": value }).to_string();
            crate::prefs_file::parse(file.as_bytes()).unwrap()
        };
        assert_eq!(read("api".into()).chat_provider, "anthropic");
        assert_eq!(read("cli".into()).chat_provider, "claude-cli");
        assert_eq!(read("claude-cli".into()).chat_provider, "claude-cli");
        assert_eq!(read("ollama".into()).chat_provider, "ollama");
        assert_eq!(read("gpt-9000".into()).chat_provider, "anthropic");
        assert_eq!(read("".into()).chat_provider, "anthropic");
        // Not a string: that field alone falls back.
        let s = read(42.into());
        assert_eq!((s.chat_provider.as_str(), s.model.as_str()), ("anthropic", "some-model"));
        let page: Settings = serde_json::from_value(serde_json::json!({ "chatProvider": "cli" })).unwrap();
        assert_eq!(page.chat_provider, "claude-cli");
    }

    #[test]
    fn the_chat_provider_settings_are_written_in_camel_case_and_read_back() {
        let file = r#"{"model":"some-model","chatProvider":"ollama",
            "chatModels":{"ollama":"llama3.2","openai":"gpt-x"},
            "ollamaUrl":"http://127.0.0.1:11434","lmstudioUrl":"http://127.0.0.1:1234",
            "customUrl":"https://llm.example.com"}"#;
        let s: Settings = crate::prefs_file::parse(file.as_bytes()).unwrap();
        assert_eq!(s.chat_provider, "ollama");
        assert_eq!(s.chat_models["openai"], "gpt-x");
        assert_eq!(s.ollama_url, "http://127.0.0.1:11434");
        assert_eq!(s.custom_url, "https://llm.example.com");
        let json = serde_json::to_value(&s).unwrap();
        for key in ["chatProvider", "chatModels", "ollamaUrl", "lmstudioUrl", "customUrl"] {
            assert!(json.get(key).is_some(), "{key}");
        }
        assert_eq!(json["chatModels"], serde_json::json!({ "ollama": "llama3.2", "openai": "gpt-x" }));
    }

    /// A broken chat field costs only itself (prefs_file salvage).
    #[test]
    fn a_bad_chat_models_field_costs_only_the_chat_models() {
        let file = r#"{"model":"some-model","chatProvider":"cli","chatModels":"gpt-x","ollamaUrl":7}"#;
        let s: Settings = crate::prefs_file::parse(file.as_bytes()).expect("salvaged, not thrown away");
        assert!(s.chat_models.is_empty());
        assert_eq!(s.ollama_url, "");
        assert_eq!(s.chat_provider, "claude-cli");
        assert_eq!(s.model, "some-model");
    }
}
