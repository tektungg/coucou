// Chat through the Claude Code CLI instead of the API: `claude -p`, signed in
// with the user's own Claude Code login, so no API key is needed.
//
// The OAuth token itself is never read or reused here: it belongs to Claude
// Code, so Claude Code is what talks to Anthropic. Coucou only hands it the
// prompt on stdin and reads the JSON result back.
//
// `--setting-sources ""` keeps the user's settings.json out of these runs. That
// matters: it is where Coucou's own hooks live, and without it every chat turn
// would show up in the island as a Claude Code session.
//
// The conversation is the shared one (conversation.rs). The Claude Code session
// it resumes lives there too: cleared by "New chat" and by any switch of
// provider. A fresh session after another provider answered gets the earlier
// turns once, as a transcript in front of the first prompt.

use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use super::{prompt, Chat, ChatContext, ChatReply, Exchange, ModelInfo, Question, Turn, CLAUDE_CLI};
use crate::{log, platform, settings};

/// A turn with a couple of web searches can take a while; past this the island
/// gets an error rather than a spinner forever.
const TURN_TIMEOUT: Duration = Duration::from_secs(180);
/// Only what a chat needs: search, fetch, and reading a file the user dropped.
/// Nothing that edits files or runs commands.
const TOOLS: &str = "WebSearch,WebFetch,Read";
/// No console window flashing up behind the island on every message.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// How much of Claude Code's stderr an error quotes.
const MAX_DETAIL_CHARS: usize = 200;
/// The models the chat view offers for the CLI: no list is asked for.
const MODELS: &[(&str, &str)] = &[
    ("claude-opus-5", "Claude Opus 5"),
    ("claude-sonnet-5", "Claude Sonnet 5"),
    ("claude-haiku-4-5", "Claude Haiku 4.5"),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub found: bool,
    pub path: String,
}

pub fn status() -> CliStatus {
    match find_claude() {
        Some(p) => CliStatus { found: true, path: p.to_string_lossy().to_string() },
        None => CliStatus { found: false, path: String::new() },
    }
}

/// The fixed model list of the picker.
pub fn models() -> Vec<ModelInfo> {
    MODELS.iter().map(|(id, label)| ModelInfo { id: id.to_string(), label: label.to_string() }).collect()
}

/// One chat turn through `claude -p`. Same contract as `claude::send`.
pub async fn send(chat: &Chat, model: &str, config_dir: &str, question: &Question) -> Result<ChatReply, String> {
    let started = Instant::now();
    let result = run(chat, model, config_dir, question).await;
    match &result {
        Ok(_) => log::line(format!("chat via claude-cli ok ({} ms)", started.elapsed().as_millis())),
        Err(err) => log::line(format!("chat via claude-cli failed: {err}")),
    }
    result
}

async fn run(chat: &Chat, model: &str, config_dir: &str, question: &Question) -> Result<ChatReply, String> {
    let exe = find_claude().ok_or_else(|| {
        "Claude Code not found. Install it, or switch the chat to another provider.".to_string()
    })?;
    let turn = chat.begin(CLAUDE_CLI);
    let (text, add_dir) = compose_prompt(&turn, &question.query, question.context_for(turn.first));
    let system = prompt::system_prompt(true);
    let args = build_args(model, &system, turn.session.as_deref(), add_dir.as_deref());

    let output = run_claude(&exe, &args, config_dir, &text).await?;
    let (answer, session) = interpret(&output)?;
    let exchange = Exchange::plain(&question.plain(turn.first), &answer).with_session(session);
    chat.commit(&turn, exchange);
    Ok(ChatReply { text: answer })
}

/// Starts `claude` with `args`, hands it `prompt` on stdin and waits for it.
async fn run_claude(exe: &Path, args: &[String], config_dir: &str, prompt: &str) -> Result<Output, String> {
    // Its own working directory, so these sessions stay out of the `/resume`
    // list of whatever project the user is in.
    let cwd = settings::local_dir().join("chat");
    platform::ensure_private_dir(&cwd).map_err(|e| format!("Can't create {}: {e}", cwd.display()))?;

    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if !config_dir.trim().is_empty() {
        cmd.env("CLAUDE_CONFIG_DIR", config_dir.trim());
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("Can't start {}: {e}", exe.display()))?;
    // The prompt goes in on stdin: no command-line quoting, no length limit.
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("Can't talk to Claude Code: {e}"))?;
        // Dropping stdin closes it, which is what tells `claude -p` to start.
    }
    // On timeout the future is dropped with the child in it; kill_on_drop ends it.
    tokio::time::timeout(TURN_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("Claude Code took longer than {} s.", TURN_TIMEOUT.as_secs()))?
        .map_err(|e| format!("Claude Code failed: {e}"))
}

/// The answer and session id of a finished run, or why there are none.
fn interpret(output: &Output) -> Result<(String, Option<String>), String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    match parse_output(&stdout) {
        Ok(parsed) => Ok(parsed),
        // No JSON at all usually means Claude Code stopped before the model
        // was called (not signed in, bad flag): its stderr says why.
        Err(err) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = first_line(&stderr).unwrap_or(err);
            Err(format!("Claude Code: {detail}"))
        }
        Err(err) => Err(err),
    }
}

/// The `claude` arguments for one turn. The prompt itself goes on stdin.
fn build_args(model: &str, system: &str, session: Option<&str>, add_dir: Option<&Path>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "json",
        "--setting-sources",
        "",
        "--tools",
        TOOLS,
        "--allowedTools",
        TOOLS,
        "--system-prompt",
        system,
        "--model",
        model,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(id) = session {
        args.push("--resume".into());
        args.push(id.into());
    }
    if let Some(dir) = add_dir {
        args.push("--add-dir".into());
        args.push(dir.to_string_lossy().to_string());
    }
    args
}

/// The text sent for one turn, plus the folder Claude needs to read a dropped
/// file. A fresh session after earlier turns gets them first, as a transcript;
/// the context (given for the first turn only) comes next, then the question.
fn compose_prompt(turn: &Turn, query: &str, context: Option<&ChatContext>) -> (String, Option<PathBuf>) {
    let mut parts = Vec::new();
    if turn.session.is_none() {
        parts.extend(prompt::transcript(&turn.history));
    }
    let mut add_dir = None;
    match context {
        Some(ChatContext::File { name, path }) => {
            parts.push(format!("File: {name}\nPath: {path}\nRead this file with the Read tool before answering."));
            add_dir = Path::new(path).parent().map(Path::to_path_buf);
        }
        Some(ChatContext::Window { app_name, title, url }) => {
            parts.push(prompt::window_line(app_name, title, url.as_deref()));
        }
        None => {}
    }
    parts.push(query.to_string());
    (parts.join("\n\n"), add_dir)
}

/// The reply text and session id from `--output-format json`.
///
/// Claude Code can print a warning line before the JSON (an unknown model, for
/// one), so the result is the last line that parses as a JSON object.
fn parse_output(stdout: &str) -> Result<(String, Option<String>), String> {
    let json = stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .find_map(|l| serde_json::from_str::<Value>(l).ok().filter(Value::is_object))
        .ok_or_else(|| "Unexpected Claude Code output.".to_string())?;

    let text = json.get("result").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if json.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
        return Err(if text.is_empty() { "Claude Code returned an error.".into() } else { text });
    }
    if text.is_empty() {
        return Err("No response text.".into());
    }
    let session = json
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok((text, session))
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(MAX_DETAIL_CHARS).collect())
}

/// `claude` on PATH, else the native installer's default location. Apps
/// started from the Start menu do get the user PATH, but not one a terminal
/// profile added on top of it.
fn find_claude() -> Option<PathBuf> {
    #[cfg(windows)]
    const NAMES: &[&str] = &["claude.exe", "claude.cmd"];
    #[cfg(not(windows))]
    const NAMES: &[&str] = &["claude"];

    let on_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    let fallback = platform::home_dir().join(".local").join("bin");
    on_path
        .iter()
        .chain(std::iter::once(&fallback))
        .flat_map(|dir| NAMES.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).map(|i| args[i + 1].as_str())
    }

    #[test]
    fn args_keep_user_settings_and_hooks_out_and_carry_the_shared_prompt() {
        let system = prompt::system_prompt(true);
        let args = build_args("claude-opus-5", &system, None, None);
        assert_eq!(args[0], "-p");
        assert_eq!(flag_value(&args, "--setting-sources"), Some(""));
        assert_eq!(flag_value(&args, "--output-format"), Some("json"));
        assert_eq!(flag_value(&args, "--model"), Some("claude-opus-5"));
        assert_eq!(flag_value(&args, "--tools"), Some(TOOLS));
        assert_eq!(flag_value(&args, "--allowedTools"), Some(TOOLS));
        assert_eq!(flag_value(&args, "--system-prompt"), Some(system.as_str()));
        assert!(system.contains("light Markdown") && system.contains("web search access"));
        assert!(!args.iter().any(|a| a == "--resume" || a == "--add-dir"));
    }

    #[test]
    fn args_never_allow_tools_that_edit_or_run_things() {
        for tool in ["Bash", "Edit", "Write", "PowerShell"] {
            assert!(!TOOLS.split(',').any(|t| t == tool), "{tool} must stay off");
        }
    }

    #[test]
    fn args_resume_the_session_and_open_the_file_folder() {
        let dir = PathBuf::from("C:/inbox");
        let args = build_args("m", "sys", Some("abc-123"), Some(&dir));
        assert_eq!(flag_value(&args, "--resume"), Some("abc-123"));
        assert_eq!(flag_value(&args, "--add-dir"), Some("C:/inbox"));
    }

    #[test]
    fn parse_reads_the_result_and_session() {
        let out = r#"{"type":"result","is_error":false,"result":"Halo!","session_id":"s1"}"#;
        assert_eq!(parse_output(out).unwrap(), ("Halo!".into(), Some("s1".into())));
    }

    #[test]
    fn parse_skips_a_warning_line_before_the_json() {
        let out = "[claude-code:unrecognized_model] {\"model\":\"x\"}\n\
                   {\"is_error\":false,\"result\":\" ok \",\"session_id\":\"s2\"}\n";
        assert_eq!(parse_output(out).unwrap(), ("ok".into(), Some("s2".into())));
    }

    #[test]
    fn parse_surfaces_errors_and_empty_replies() {
        let err = r#"{"is_error":true,"result":"Not logged in · Please run /login"}"#;
        assert_eq!(parse_output(err).unwrap_err(), "Not logged in · Please run /login");
        let bare = r#"{"is_error":true,"result":""}"#;
        assert_eq!(parse_output(bare).unwrap_err(), "Claude Code returned an error.");
        let empty = r#"{"is_error":false,"result":"   ","session_id":"s"}"#;
        assert_eq!(parse_output(empty).unwrap_err(), "No response text.");
    }

    #[test]
    fn parse_rejects_output_without_json() {
        assert!(parse_output("").is_err());
        assert!(parse_output("Error: something broke\n{not json").is_err());
        assert!(parse_output("[1,2,3]").is_err());
    }

    #[test]
    fn prompt_carries_file_context_on_the_first_turn_only() {
        let chat = Chat::default();
        let file = ChatContext::File { name: "notes.md".into(), path: "C:/Users/me/inbox/notes.md".into() };
        let turn = chat.begin(CLAUDE_CLI);
        let (prompt, dir) = compose_prompt(&turn, "summarise", Some(&file));
        assert!(prompt.starts_with("File: notes.md\nPath: C:/Users/me/inbox/notes.md"));
        assert!(prompt.ends_with("summarise"));
        assert_eq!(dir, Some(PathBuf::from("C:/Users/me/inbox")));

        chat.commit(&turn, Exchange::plain("summarise", "Done.").with_session(Some("s1".into())));
        let turn = chat.begin(CLAUDE_CLI);
        let q = Question { query: "and then?".into(), context: Some(file) };
        let (later, dir) = compose_prompt(&turn, &q.query, q.context_for(turn.first));
        assert_eq!(later, "and then?", "the session already has the file and the turns");
        assert_eq!(dir, None);
    }

    #[test]
    fn prompt_carries_window_context() {
        let window = ChatContext::Window {
            app_name: "Chrome".into(),
            title: "Docs".into(),
            url: Some("https://example.com".into()),
        };
        let turn = Chat::default().begin(CLAUDE_CLI);
        let (prompt, dir) = compose_prompt(&turn, "what is this?", Some(&window));
        assert_eq!(prompt, "Context: App: Chrome, Window: Docs, URL: https://example.com\n\nwhat is this?");
        assert_eq!(dir, None);
    }

    #[test]
    fn a_switch_to_the_cli_sends_the_earlier_turns_once() {
        let chat = Chat::default();
        let t = chat.begin("openai");
        chat.commit(&t, Exchange::plain("Remember 7316.", "OK."));
        let turn = chat.begin(CLAUDE_CLI);
        assert_eq!(turn.session, None);
        let (prompt, _) = compose_prompt(&turn, "Which number?", None);
        assert!(prompt.contains("User: Remember 7316.\n\nMochi: OK."), "{prompt}");
        assert!(prompt.ends_with("Which number?"));

        // Once the CLI answered in a session, that session carries the turns.
        chat.commit(&turn, Exchange::plain("Which number?", "7316").with_session(Some("s1".into())));
        let turn = chat.begin(CLAUDE_CLI);
        assert_eq!(turn.session.as_deref(), Some("s1"));
        assert_eq!(compose_prompt(&turn, "Thanks", None).0, "Thanks");
    }

    #[test]
    fn the_model_list_is_fixed_and_named() {
        let ids: Vec<_> = models().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);
        assert_eq!(models()[2].label, "Claude Haiku 4.5");
    }

    /// Live eval against the real CLI and the signed-in account (costs a few
    /// Haiku tokens). Run with:
    /// `cargo test claude_cli_live -- --ignored --nocapture`
    /// Set COUCOU_CLAUDE_CONFIG_DIR to test another profile.
    #[test]
    #[ignore]
    fn claude_cli_live_two_turns_keep_context() {
        let config = std::env::var("COUCOU_CLAUDE_CONFIG_DIR").unwrap_or_default();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chat = Chat::default();
        let model = "claude-haiku-4-5";
        let ask = |q: &str| Question { query: q.into(), context: None };
        rt.block_on(async {
            let first = run(&chat, model, &config, &ask("Remember the number 7316. Reply OK.")).await.expect("first turn");
            println!("turn 1: {}", first.text);
            assert!(chat.begin(CLAUDE_CLI).session.is_some(), "session id kept");
            let second = run(&chat, model, &config, &ask("Which number did I give you? Digits only.")).await.expect("second turn");
            println!("turn 2: {}", second.text);
            assert!(second.text.contains("7316"), "resume lost the context: {}", second.text);
        });
    }

    /// Live eval of a provider switch: OpenAI-style turns recorded first, then
    /// the CLI starts fresh and must still know them from the transcript.
    #[test]
    #[ignore]
    fn claude_cli_live_switch_brings_the_transcript() {
        let config = std::env::var("COUCOU_CLAUDE_CONFIG_DIR").unwrap_or_default();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chat = Chat::default();
        let t = chat.begin("openai");
        chat.commit(&t, Exchange::plain("My locker code is 4417.", "Noted."));
        let q = Question { query: "What is my locker code? Digits only.".into(), context: None };
        let reply = rt.block_on(run(&chat, "claude-haiku-4-5", &config, &q)).expect("cli turn");
        println!("cli: {}", reply.text);
        assert!(reply.text.contains("4417"), "transcript lost: {}", reply.text);
    }
}
