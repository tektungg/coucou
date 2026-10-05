// Relay server for coucou-hook.
//
// Windows: the named pipe `\\.\pipe\coucou-<sid>`, one instance per connection.
// Linux: the Unix socket `$XDG_RUNTIME_DIR/coucou.sock`. Every hook event is
// forwarded to the island as a `hook` event. `PermissionRequest` is the only one
// that keeps its connection open: it waits for the island's decision and writes
// it back on the same connection, which is how approving from the island works.
//
// Claude Code is never blocked by us. Three things guarantee it:
//   * coucou-hook gives the connection 300 ms and exits cleanly if we are closed;
//   * we only wait for a human once the island has *confirmed* the card is on
//     screen, so a paused island or a webview that is not listening costs a few
//     hundred milliseconds, not two minutes;
//   * whatever happens we drop the connection after the decision timeout, and
//     the terminal takes over.
//
// What we write back is the bare word `allow` or `deny`. Turning that into the
// documented hookSpecificOutput JSON is coucou-hook's job, so the wire format
// Claude Code expects lives in exactly one place.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::island::WINDOW_LABEL;
use crate::log;

/// Slightly under coucou-hook's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// How long the island gets to say "the card is up". This is the whole of B4:
/// without it, an island that is paused, hidden behind a crashed webview or
/// simply not listening would leave Claude Code staring at a prompt nobody can
/// see for nearly two minutes.
const ACK_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_PAYLOAD: usize = 1 << 20;

/// What the island can say about a permission request.
pub enum Reply {
    /// The card is on screen and a human can act on it.
    Ack,
    /// A human clicked: `allow` or `deny`.
    Decision(String),
    /// Nobody can act on it — paused, or another request already holds the card.
    Decline,
}

/// Permission requests the island has been told about.
#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Reply>>>);

static COUNTER: AtomicU64 = AtomicU64::new(1);

/// `\\.\pipe\coucou-<sid>` — must match coucou-hook's `pipe_path()` exactly.
#[cfg(windows)]
pub fn pipe_name() -> String {
    let key = crate::platform::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\coucou-{key}")
}

#[cfg(windows)]
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        // first_pipe_instance also means we refuse to join a pipe somebody else
        // already owns under our name, rather than serving on top of it.
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot open the relay pipe: {err}"));
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            // Hand the connected instance to a task and listen on a fresh one.
            let next = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(err) => {
                    log::line(format!("cannot reopen the relay pipe: {err}"));
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, connected).await });
        }
    });
}

#[cfg(target_os = "linux")]
pub fn start(app: AppHandle) {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    tauri::async_runtime::spawn(async move {
        let Some(path) = crate::platform::relay_socket_path() else {
            log::line("no private runtime directory ($XDG_RUNTIME_DIR) — Claude Code hooks are inactive");
            return;
        };
        // A socket file left behind by a crash answers nothing and can go. One
        // that answers belongs to a Coucou that is still running: like
        // first_pipe_instance on Windows, we refuse to serve on top of it.
        if path.exists() {
            if std::os::unix::net::UnixStream::connect(&path).is_ok() {
                log::line("another Coucou already serves the relay socket");
                return;
            }
            let _ = std::fs::remove_file(&path);
        }
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(err) => {
                log::line(format!("cannot open the relay socket: {err}"));
                return;
            }
        };
        // The runtime directory is already 0700; this is belt and braces.
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        let uid = unsafe { libc::getuid() };
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
            };
            // Only the relay run by our own user may drive the island.
            if !matches!(stream.peer_cred(), Ok(c) if c.uid() == uid) {
                log::line("refused a relay connection from another user");
                continue;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, stream).await });
        }
    });
}

/// One accepted relay connection, whatever carries it.
trait Relay: AsyncRead + AsyncWrite + Unpin {
    /// Ends the conversation once everything has been written.
    fn finish(&mut self) {}
}

#[cfg(windows)]
impl Relay for NamedPipeServer {
    fn finish(&mut self) {
        let _ = self.disconnect();
    }
}

/// Dropping the stream closes it; the relay reads up to our newline first.
#[cfg(target_os = "linux")]
impl Relay for tokio::net::UnixStream {}

async fn handle(app: AppHandle, mut pipe: impl Relay) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > MAX_PAYLOAD {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let line = match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[..i],
        None => &buf[..],
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(line) else { return };
    if !payload.is_object() {
        return;
    }

    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // AskUserQuestion comes in through the relay's `--ask` PreToolUse hook and
    // waits for the island's answers, exactly like a permission request.
    let is_ask = payload.get("coucou_kind").and_then(Value::as_str) == Some(ASK_KIND);
    if event != "PermissionRequest" && !is_ask {
        log::line(format!("hook {event}"));
        let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
        pipe.finish();
        return;
    }

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<Reply>(4);
    {
        let pending = app.state::<Pending>();
        pending.0.lock().unwrap().insert(id.clone(), tx);
    }
    payload["request_id"] = json!(id);
    log::line(format!("hook {} id={id}", if is_ask { "AskUserQuestion" } else { "PermissionRequest" }));
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);

    // The terminal shows its own dialog at the same time, and whichever is
    // answered first wins. When it is the terminal, Claude Code aborts the hook:
    // the relay dies and its end of the pipe closes. Watching for that is how
    // the island learns to take its card down instead of waiting it out.
    let decision = tokio::select! {
        d = wait_for_decision(&id, &mut rx) => d,
        () = relay_gone(&mut pipe) => {
            log::line(format!("hook id={id} answered in the terminal"));
            let _ = app.emit_to(WINDOW_LABEL, "hook-gone", json!({ "request_id": id }));
            None
        }
    };
    app.state::<Pending>().0.lock().unwrap().remove(&id);

    // No decision: say nothing at all. coucou-hook then writes nothing to stdout
    // and Claude Code asks in the terminal, exactly as if Coucou were closed.
    if let Some(d) = decision {
        let _ = pipe.write_all(format!("{d}\n").as_bytes()).await;
        let _ = pipe.flush().await;
    }
    pipe.finish();
}

/// Resolves when the relay hangs up. It sends nothing after its one line, so
/// any read that returns is the end: EOF, a broken pipe, or a stray byte from
/// a relay that is about to exit anyway.
async fn relay_gone(pipe: &mut impl Relay) {
    let mut byte = [0u8; 1];
    loop {
        match pipe.read(&mut byte).await {
            Ok(0) | Err(_) => return,
            Ok(_) => continue,
        }
    }
}

/// Two waits: a short one for "the card is up", then the long one for a human.
async fn wait_for_decision(id: &str, rx: &mut mpsc::Receiver<Reply>) -> Option<String> {
    match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack)) => {}
        // A click that beats the ack is still a click.
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {d}"));
            return Some(d);
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} not shown — terminal takes over"));
            return None;
        }
        Ok(None) => return None,
        Err(_) => {
            log::line(format!("hook id={id} island never acknowledged — terminal takes over"));
            return None;
        }
    }

    match tokio::time::timeout(DECISION_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {d}"));
            Some(d)
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} released without a decision"));
            None
        }
        _ => {
            log::line(format!("hook id={id} timed out — terminal takes over"));
            None
        }
    }
}

fn send(app: &AppHandle, request_id: &str, reply: Reply, keep: bool) {
    let sender = {
        let pending = app.state::<Pending>();
        let mut map = pending.0.lock().unwrap();
        if keep { map.get(request_id).cloned() } else { map.remove(request_id) }
    };
    match sender {
        Some(tx) => {
            let _ = tx.try_send(reply);
        }
        None => log::line(format!("reply for id={request_id} — no pending request")),
    }
}

/// The island has the card on screen; the long wait may begin.
pub fn acknowledge(app: &AppHandle, request_id: &str) {
    send(app, request_id, Reply::Ack, true);
}

/// Nobody can act on this one — paused, or another card already holds the view.
pub fn decline(app: &AppHandle, request_id: &str) {
    log::line(format!("decline id={request_id}"));
    send(app, request_id, Reply::Decline, false);
}

/// Called by the island's cards. Turning the answer into Claude Code's JSON is
/// coucou-hook's job; this only lets through the line shapes it understands.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    match answer_line(decision) {
        Some(line) => {
            log::line(format!("decision id={request_id} {}", describe(&line)));
            send(app, request_id, Reply::Decision(line), false);
        }
        // Something we do not understand is not a decision: let the terminal ask.
        None => {
            log::line(format!("decision id={request_id} unrecognised — terminal takes over"));
            send(app, request_id, Reply::Decline, false);
        }
    }
}

/// Tag the relay puts on an AskUserQuestion that waits for the island.
const ASK_KIND: &str = "ask_user_question";
/// Plan approvals may only switch to one of these.
const PLAN_MODES: &[&str] = &["bypassPermissions", "acceptEdits", "default"];
const MAX_FEEDBACK: usize = 4_000;

/// The single line written back to the relay, or None when `decision` is not a
/// shape coucou-hook understands. Words: allow / always / deny. JSON objects:
/// `{"plan":"<mode>"}`, `{"feedback":"…"}`, `{"answers":{"<q>":"<a>"|["<a>"…]}}`.
/// JSON is re-serialised, so a stray newline can never split the line.
fn answer_line(decision: &str) -> Option<String> {
    match decision.trim() {
        "allow" | "always" => return Some("allow".into()),
        "deny" => return Some("deny".into()),
        _ => {}
    }
    let v = serde_json::from_str::<Value>(decision).ok()?;
    let obj = v.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    if let Some(mode) = obj.get("plan").and_then(Value::as_str) {
        return PLAN_MODES.contains(&mode).then(|| json!({ "plan": mode }).to_string());
    }
    if let Some(text) = obj.get("feedback").and_then(Value::as_str) {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        let text: String = text.chars().take(MAX_FEEDBACK).collect();
        return Some(json!({ "feedback": text }).to_string());
    }
    if let Some(answers) = obj.get("answers").and_then(Value::as_object) {
        let ok = !answers.is_empty()
            && answers.values().all(|a| match a {
                Value::String(_) => true,
                Value::Array(items) => !items.is_empty() && items.iter().all(Value::is_string),
                _ => false,
            });
        return ok.then(|| json!({ "answers": answers }).to_string());
    }
    None
}

/// Short form for the log: never the feedback or the answers themselves.
fn describe(line: &str) -> String {
    match serde_json::from_str::<Value>(line) {
        Ok(v) if v.get("plan").is_some() => format!("plan:{}", v["plan"].as_str().unwrap_or("")),
        Ok(v) if v.get("feedback").is_some() => "feedback".into(),
        Ok(v) if v.get("answers").is_some() => "answers".into(),
        _ => line.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_words_pass_through() {
        assert_eq!(answer_line("allow").as_deref(), Some("allow"));
        assert_eq!(answer_line("always").as_deref(), Some("allow"));
        assert_eq!(answer_line(" deny ").as_deref(), Some("deny"));
    }

    #[test]
    fn plan_modes_are_whitelisted() {
        assert_eq!(answer_line(r#"{"plan":"acceptEdits"}"#).as_deref(), Some(r#"{"plan":"acceptEdits"}"#));
        assert!(answer_line(r#"{"plan":"bypassPermissions"}"#).is_some());
        assert!(answer_line(r#"{"plan":"default"}"#).is_some());
        assert!(answer_line(r#"{"plan":"dontAsk"}"#).is_none());
        assert!(answer_line(r#"{"plan":"acceptEdits","feedback":"x"}"#).is_none());
    }

    #[test]
    fn feedback_is_trimmed_capped_and_kept_on_one_line() {
        let line = answer_line("{\"feedback\":\"  line one\\nline two  \"}").unwrap();
        assert!(!line.contains('\n'));
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["feedback"], "line one\nline two");
        let long = format!(r#"{{"feedback":"{}"}}"#, "é".repeat(5_000));
        let v: Value = serde_json::from_str(&answer_line(&long).unwrap()).unwrap();
        assert_eq!(v["feedback"].as_str().unwrap().chars().count(), MAX_FEEDBACK);
        assert!(answer_line(r#"{"feedback":"  "}"#).is_none());
    }

    #[test]
    fn answers_must_be_strings_or_string_lists() {
        assert!(answer_line(r#"{"answers":{"Q?":"A","M?":["x","y"]}}"#).is_some());
        assert!(answer_line(r#"{"answers":{}}"#).is_none());
        assert!(answer_line(r#"{"answers":{"Q?":1}}"#).is_none());
        assert!(answer_line(r#"{"answers":{"Q?":[]}}"#).is_none());
    }

    #[test]
    fn anything_else_is_not_a_decision() {
        assert!(answer_line("").is_none());
        assert!(answer_line("yes").is_none());
        assert!(answer_line("[1]").is_none());
        assert!(answer_line(r#"{"permissionDecision":"allow"}"#).is_none());
    }

    #[test]
    fn the_log_never_carries_what_was_typed() {
        assert_eq!(describe(r#"{"feedback":"secret plan notes"}"#), "feedback");
        assert_eq!(describe(r#"{"answers":{"Q":"A"}}"#), "answers");
        assert_eq!(describe(r#"{"plan":"acceptEdits"}"#), "plan:acceptEdits");
        assert_eq!(describe("allow"), "allow");
    }
}
