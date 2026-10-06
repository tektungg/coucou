// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    /// "api" = Anthropic API key, "cli" = the Claude Code CLI with the user's
    /// own login (claude_cli.rs).
    #[serde(default = "default_chat_provider")]
    pub chat_provider: String,
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

/// The stock integrations this build hides (Claude Code covers them).
pub const HIDDEN_INTEGRATIONS: &[&str] = &[
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
    "integration_notion", "integration_calcom", "integration_stripe",
];

/// This build's own pills, on by default.
pub const PERSONAL_INTEGRATIONS: &[&str] = &[
    "integration_space", "integration_media", "integration_messages", "integration_shelf", "integration_audio",
];

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

fn default_message_apps() -> Vec<String> {
    ["discord", "slack", "telegram", "whatsapp"].iter().map(|s| s.to_string()).collect()
}

fn personal_defaults() -> Vec<String> {
    PERSONAL_INTEGRATIONS.iter().map(|s| s.to_string()).collect()
}

/// Drops the hidden stock pills. A list that held nothing else (the stock
/// defaults every older settings.json carries) becomes this build's own set,
/// so an upgrade lands on working pills instead of none.
fn migrate_integrations(active: &[String]) -> Vec<String> {
    let kept: Vec<String> = active
        .iter()
        .filter(|id| !HIDDEN_INTEGRATIONS.contains(&id.as_str()))
        .cloned()
        .collect();
    if kept.is_empty() && !active.is_empty() {
        personal_defaults()
    } else {
        kept
    }
}

fn default_chat_provider() -> String {
    "api".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: personal_defaults(),
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            chat_provider: default_chat_provider(),
            claude_config_dir: String::new(),
            slack_workspace: String::new(),
            space_timebox_dir: String::new(),
            message_apps: default_message_apps(),
            lyrics_enabled: true,
            lyrics_romanized: false,
            pill_layout: PILL_LAYOUT,
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

pub fn load() -> Settings {
    let mut settings: Settings = match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    settings.active_integrations = migrate_integrations(&settings.active_integrations);
    if migrate_pills(&mut settings) {
        // Saved at once: a migration that ran on every start would bring back
        // a pill the user later switched off.
        let _ = save(&settings);
    }
    settings
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
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
        let mixed = ids(&["integration_github", "integration_space", "integration_media"]);
        assert_eq!(migrate_integrations(&mixed), ids(&["integration_space", "integration_media"]));
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

    /// A settings.json written before the CLI chat existed must still load,
    /// and keep chatting through the API key it was set up with.
    #[test]
    fn older_settings_default_to_the_api_chat() {
        let old = r#"{"soundEnabled":true,"soundVolume":0.1,"autoCloseInterval":15,
            "absenceInterval":180,"activeIntegrations":[],"screen":"primary",
            "autostart":false,"hooksInstalled":true,"model":"claude-sonnet-5"}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert_eq!(s.chat_provider, "api");
        assert_eq!(s.claude_config_dir, "");
        assert_eq!(s.model, "claude-sonnet-5");
    }
}
