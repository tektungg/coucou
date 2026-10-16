// The chat, whoever answers it: which provider a turn goes to, the context that
// may ride along, and the shapes the island sees. Each provider's own wire
// format lives in its module: claude.rs (Anthropic API), claude_cli.rs (the
// Claude Code CLI on the user's own login), openai_compat.rs (OpenAI, Google
// AI, OpenRouter) and local_chat.rs (Ollama, LM Studio, any OpenAI-compatible
// server). conversation.rs keeps the history, prompt.rs the words.
//
// API keys never leave the credential store and file bytes never cross the IPC
// boundary: the island sends the question and gets the answer's text back.
// Ported from upstream (b2ad213, cab5e74, 6fd7743, 5bddaec), plus the CLI.

pub(crate) mod claude;
mod claude_cli;
pub mod commands;
mod conversation;
mod identity;
mod local_chat;
mod net;
mod openai_compat;
mod prompt;

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::settings::Settings;
use crate::secrets;

pub use conversation::{Chat, Exchange, Turn};
pub use local_chat::CUSTOM_KEY;

/// The Anthropic API, with the key in the credential store.
pub const ANTHROPIC: &str = "anthropic";
/// The Claude Code CLI, signed in with the user's own login.
pub const CLAUDE_CLI: &str = "claude-cli";
/// What settings.json said before there were more providers than these two.
const LEGACY_API: &str = "api";
const LEGACY_CLI: &str = "cli";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatContext {
    File { name: String, path: String },
    Window { app_name: String, title: String, url: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
}

/// A model a provider offers, for the picker in the chat view.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

/// What the user asked: the question, and the file or window it is about.
pub struct Question {
    pub query: String,
    pub context: Option<ChatContext>,
}

impl Question {
    /// The context, on the first turn only: later turns already have it.
    pub fn context_for(&self, first: bool) -> Option<&ChatContext> {
        self.context.as_ref().filter(|_| first)
    }

    /// The plain-text record of this question, context included.
    pub fn plain(&self, first: bool) -> String {
        prompt::plain_question(first, self.context.as_ref(), &self.query)
    }
}

// ── Which provider ────────────────────────────────────────────────────────────

fn is_provider(id: &str) -> bool {
    id == ANTHROPIC
        || id == CLAUDE_CLI
        || openai_compat::provider(id).is_some()
        || local_chat::SERVER_IDS.contains(&id)
}

/// The provider a settings file names, in this build's ids: the older "api"
/// and "cli" become "anthropic" and "claude-cli", anything unknown is Anthropic.
pub fn provider_id(stored: &str) -> String {
    match stored.trim() {
        LEGACY_API => ANTHROPIC.to_string(),
        LEGACY_CLI => CLAUDE_CLI.to_string(),
        id if is_provider(id) => id.to_string(),
        _ => ANTHROPIC.to_string(),
    }
}

/// The Claude model of the settings window, or the default one.
fn claude_model(settings: &Settings) -> String {
    let m = settings.model.trim();
    if m.is_empty() { claude::DEFAULT_MODEL.to_string() } else { m.to_string() }
}

/// The model chosen for `provider`, or its default. Anthropic's is `model`;
/// the CLI falls back to it too, which is what it ran on before it had its own.
pub fn model_for(settings: &Settings, provider: &str) -> String {
    if provider == ANTHROPIC {
        return claude_model(settings);
    }
    let chosen = settings.chat_models.get(provider).map(|m| m.trim()).filter(|m| !m.is_empty());
    if let Some(m) = chosen {
        return m.to_string();
    }
    if provider == CLAUDE_CLI {
        return claude_model(settings);
    }
    openai_compat::provider(provider).map(|p| p.default_model.to_string()).unwrap_or_default()
}

// ── Context ───────────────────────────────────────────────────────────────────

/// A file rides along only if it is one of Coucou's own copies of a dropped
/// file (files.rs puts them in the inbox). The page names the path, so without
/// this any file the user can read could be sent to a chat provider. Anything
/// else is dropped from the turn: the question still goes, without it.
fn checked_context(context: ChatContext) -> Option<ChatContext> {
    match &context {
        ChatContext::File { path, .. } if !is_inside(&crate::files::inbox_dir(), Path::new(path)) => {
            crate::log::line("chat: a file outside the inbox was left out of the question");
            None
        }
        _ => Some(context),
    }
}

/// True when `path` is a regular file (not a symlink) directly inside `dir`,
/// both resolved: no `..`, no link pointing out of it.
fn is_inside(dir: &Path, path: &Path) -> bool {
    let regular = std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file());
    let (Ok(dir), Ok(file)) = (dir.canonicalize(), path.canonicalize()) else { return false };
    regular && file.parent() == Some(dir.as_path())
}

/// The lowercase extension of a file path, or "".
pub(crate) fn file_extension(path: &str) -> String {
    Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

/// The media type of an image every provider here accepts inline.
pub(crate) fn image_media_type(ext: &str) -> Option<&'static str> {
    match ext {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

// ── One turn ──────────────────────────────────────────────────────────────────

/// One chat turn with the provider chosen in the settings.
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    settings: &Settings,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let question = Question { query, context: context.and_then(checked_context) };
    let provider = settings.chat_provider.as_str();
    let model = model_for(settings, provider);
    if provider == ANTHROPIC || provider.is_empty() {
        return claude::send(chat, &model, &question).await;
    }
    if provider == CLAUDE_CLI {
        return claude_cli::send(chat, &model, &settings.claude_config_dir, &question).await;
    }
    if let Some(p) = openai_compat::provider(provider) {
        return openai_compat::send(chat, p, &model, &question).await;
    }
    if let Some(server) = local_chat::server(settings, provider) {
        return local_chat::send(app, chat, &server, &model, &question).await;
    }
    Err(format!("Unknown chat provider: {provider}"))
}

/// The models `provider` offers. Asked only when the user opens the picker on
/// that provider, and only once it has a key (or, for a local server, an
/// address): nothing is sent anywhere before that. The CLI's list is fixed.
pub async fn models(settings: &Settings, provider: &str) -> Result<Vec<ModelInfo>, String> {
    const NO_KEY: &str = "No API key. Add it in Settings.";
    if provider == ANTHROPIC {
        let key = secrets::get(claude::KEY).ok_or(NO_KEY)?;
        return claude::models(&key).await;
    }
    if provider == CLAUDE_CLI {
        return Ok(claude_cli::models());
    }
    if let Some(p) = openai_compat::provider(provider) {
        let key = secrets::get(p.key).ok_or(NO_KEY)?;
        return openai_compat::models(p, &key).await;
    }
    if let Some(server) = local_chat::server(settings, provider) {
        return local_chat::models(&server).await;
    }
    Err(format!("Unknown chat provider: {provider}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_comes_from_the_settings_or_the_provider_default() {
        let mut s = Settings::default();
        assert_eq!(model_for(&s, ANTHROPIC), claude::DEFAULT_MODEL);
        assert_eq!(model_for(&s, "openai"), openai_compat::provider("openai").unwrap().default_model);
        assert_eq!(model_for(&s, "ollama"), "");
        s.chat_models.insert("openai".into(), " gpt-x ".into());
        s.chat_models.insert("ollama".into(), "llama3.2".into());
        s.model = "claude-haiku-4-5".into();
        assert_eq!(model_for(&s, "openai"), "gpt-x");
        assert_eq!(model_for(&s, "ollama"), "llama3.2");
        assert_eq!(model_for(&s, ANTHROPIC), "claude-haiku-4-5");
    }

    #[test]
    fn the_cli_has_its_own_model_and_falls_back_to_the_claude_one() {
        let mut s = Settings { model: "claude-sonnet-5".into(), ..Settings::default() };
        assert_eq!(model_for(&s, CLAUDE_CLI), "claude-sonnet-5");
        s.chat_models.insert(CLAUDE_CLI.into(), "claude-haiku-4-5".into());
        assert_eq!(model_for(&s, CLAUDE_CLI), "claude-haiku-4-5");
        // Anthropic never reads the map: its model is `model`.
        s.chat_models.insert(ANTHROPIC.into(), "ignored".into());
        assert_eq!(model_for(&s, ANTHROPIC), "claude-sonnet-5");
        s.model = "  ".into();
        assert_eq!(model_for(&s, ANTHROPIC), claude::DEFAULT_MODEL);
    }

    #[test]
    fn older_and_unknown_provider_ids_are_mapped() {
        assert_eq!(provider_id("api"), ANTHROPIC);
        assert_eq!(provider_id("cli"), CLAUDE_CLI);
        assert_eq!(provider_id(""), ANTHROPIC);
        assert_eq!(provider_id("something-else"), ANTHROPIC);
        for id in [ANTHROPIC, CLAUDE_CLI, "openai", "google", "openrouter", "ollama", "lmstudio", "custom"] {
            assert_eq!(provider_id(id), id);
        }
    }

    #[test]
    fn only_files_in_the_inbox_ride_along() {
        let base = std::env::temp_dir().join(format!("coucou-chat-ctx-{}", std::process::id()));
        let inbox = base.join("inbox");
        std::fs::create_dir_all(inbox.join("sub")).unwrap();
        std::fs::write(inbox.join("a.txt"), b"a").unwrap();
        std::fs::write(base.join("secret.txt"), b"s").unwrap();
        std::fs::write(inbox.join("sub").join("b.txt"), b"b").unwrap();
        assert!(is_inside(&inbox, &inbox.join("a.txt")));
        assert!(!is_inside(&inbox, &base.join("secret.txt")));
        assert!(!is_inside(&inbox, &inbox.join("..").join("secret.txt")));
        assert!(!is_inside(&inbox, &inbox.join("sub").join("b.txt")));
        assert!(!is_inside(&inbox, &inbox.join("missing.txt")));
        assert!(!is_inside(&inbox, &inbox));
        #[cfg(unix)]
        {
            // A link is refused even when it points at another file of the inbox.
            std::os::unix::fs::symlink(base.join("secret.txt"), inbox.join("link.txt")).unwrap();
            assert!(!is_inside(&inbox, &inbox.join("link.txt")));
            std::os::unix::fs::symlink(inbox.join("a.txt"), inbox.join("same.txt")).unwrap();
            assert!(!is_inside(&inbox, &inbox.join("same.txt")));
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_file_outside_the_inbox_is_dropped_and_a_window_kept() {
        let outside = ChatContext::File { name: "x".into(), path: "/no/such/x.txt".into() };
        assert!(checked_context(outside).is_none());
        let window = ChatContext::Window { app_name: "Code".into(), title: "t".into(), url: None };
        assert!(matches!(checked_context(window), Some(ChatContext::Window { .. })));
    }

    #[test]
    fn file_helpers_name_images_by_their_extension() {
        assert_eq!(file_extension("C:/a/Pic.JPG"), "jpg");
        assert_eq!(file_extension("/a/no-ext"), "");
        assert_eq!(image_media_type("jpeg"), Some("image/jpeg"));
        assert_eq!(image_media_type("webp"), Some("image/webp"));
        assert_eq!(image_media_type("pdf"), None);
    }

    #[test]
    fn the_context_goes_with_the_first_question_only() {
        let q = Question {
            query: "why?".into(),
            context: Some(ChatContext::File { name: "a.txt".into(), path: "/x/a.txt".into() }),
        };
        assert!(q.context_for(true).is_some());
        assert!(q.context_for(false).is_none());
        assert_eq!(q.plain(true), "File: a.txt\n\nwhy?");
        assert_eq!(q.plain(false), "why?");
    }
}
