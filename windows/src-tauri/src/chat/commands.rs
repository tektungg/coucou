// The chat commands the island and the settings window invoke. API keys and
// file bytes stay on this side: a page sends the question and gets text back.

use tauri::{AppHandle, State};

use super::claude_cli::{self, CliStatus};
use super::local_chat::{self, Connected};
use super::{Chat, ChatContext, ChatReply, ModelInfo};
use crate::Shared;

/// One chat turn with the provider picked in the chat view. A local server's
/// answer also streams to the island as `chat-delta` events.
#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let settings = shared.settings.lock().unwrap().clone();
    super::send(&app, &chat, &settings, query, context).await
}

/// The models a provider offers, for the picker in the chat view. Only asked
/// once the user picked that provider, and only with its key or address.
#[tauri::command]
pub async fn chat_models(shared: State<'_, Shared>, provider: String) -> Result<Vec<ModelInfo>, String> {
    let settings = shared.settings.lock().unwrap().clone();
    super::models(&settings, &provider).await
}

/// "New chat": forgets the conversation and the Claude Code session.
#[tauri::command]
pub fn chat_reset(chat: State<Chat>) {
    chat.reset();
}

/// Whether the Claude Code CLI the chat can run through is installed, and where.
#[tauri::command]
pub fn claude_cli_status() -> CliStatus {
    claude_cli::status()
}

/// Settings → Local models → Connect: does the server answer, and with which models?
#[tauri::command]
pub async fn local_connect(provider: String, url: String) -> Result<Connected, String> {
    local_chat::connect(&provider, &url).await
}

/// Stores the custom server's key for the address typed next to it; it is only
/// ever sent to that address. An empty key removes it.
#[tauri::command]
pub fn local_set_key(url: String, key: String) -> Result<(), String> {
    local_chat::set_custom_key(&url, &key)
}
