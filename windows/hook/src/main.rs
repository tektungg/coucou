//! coucou-hook — the relay Claude Code runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Coucou over the named pipe `\\.\pipe\coucou-<sid>` (Windows) or the Unix
//! socket `$XDG_RUNTIME_DIR/coucou.sock` (Linux).
//!
//! Hard rule (docs/CLAUDE.md): **never block Claude Code.**
//! * If the pipe does not exist — Coucou is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for an answer, because approving from the
//!   island is the whole point. No answer means empty stdout, and Claude Code
//!   asks in the terminal exactly as if Coucou were not installed.
//!
//! * `--ask` (installed as a `PreToolUse` hook matching `AskUserQuestion`) waits
//!   too: the island shows the questions and sends the answers back.
//!
//! Usage: `coucou-hook [--agent <name>] [--ask] <EventName>` (the name is also
//! read from the JSON).

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them.
const DROPPED_FIELDS: &[&str] = &["tool_response", "transcript_path"];
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;
/// ExitPlanMode's `plan` is the whole point of its card, so it gets far more room.
const MAX_PLAN_LEN: usize = 64_000;
/// Modes a plan approval may switch the session to.
const PLAN_MODES: &[&str] = &["bypassPermissions", "acceptEdits", "default"];

/// What the answer is turned into: the parts of the original payload the output
/// has to echo, kept before any truncation.
struct Context {
    event: String,
    /// Run as the `--ask` PreToolUse hook for AskUserQuestion.
    ask: bool,
    tool_name: String,
    tool_input: serde_json::Value,
    permission_suggestions: serde_json::Value,
}

/// Tools whose permission card *is* the user's answer. Claude Code ignores a
/// hook's plain "allow" for these ("canUseTool is required") and keeps waiting
/// on the terminal dialog; it only takes the hook's word when the decision
/// carries `updatedInput` ("Hook satisfied user interaction … via
/// updatedInput"). Verified against CLI 2.1.289 through the Agent SDK.
const USER_INTERACTION_TOOLS: &[&str] = &["ExitPlanMode", "AskUserQuestion"];

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::connect;

#[cfg(target_os = "linux")]
mod unix;
#[cfg(target_os = "linux")]
use unix::connect;

fn main() {
    let Some((payload, ctx)) = read_event() else { std::process::exit(0) };

    let waits_for_answer = ctx.event == "PermissionRequest" || ctx.ask;
    let budget = if waits_for_answer { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    if let Ok(Some(decision)) = rx.recv_timeout(budget) {
        if let Some(json) = decision_output(&ctx, &decision) {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
    // Nothing printed: Claude Code asks in the terminal, as if we were not here.
    std::process::exit(0);
}

/// The hook output for the island's answer. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer, and Claude
/// Code then asks in the terminal. See https://code.claude.com/docs/en/hooks
///
/// The answer line is either a bare word (`allow`, `always`, `deny`) or one of
/// three JSON objects: `{"plan":"<mode>"}`, `{"feedback":"…"}`, `{"answers":{…}}`.
fn decision_output(ctx: &Context, decision: &str) -> Option<String> {
    use serde_json::{json, Value};
    let decision = decision.trim();

    if ctx.ask {
        // AskUserQuestion through PreToolUse: allow it with the answers filled
        // in, echoing the questions exactly as Claude Code sent them.
        let parsed = serde_json::from_str::<Value>(decision).ok()?;
        let answers = parsed.get("answers").filter(|a| valid_answers(a))?;
        let questions = ctx.tool_input.get("questions")?;
        return Some(
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "updatedInput": { "questions": questions, "answers": answers },
                }
            })
            .to_string(),
        );
    }
    if ctx.event != "PermissionRequest" {
        return None;
    }

    let interactive = USER_INTERACTION_TOOLS.contains(&ctx.tool_name.as_str());
    let mut behavior = match decision {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not Claude Code's.
        "allow" | "always" => json!({ "behavior": "allow" }),
        "deny" => json!({ "behavior": "deny", "message": "Denied from Coucou" }),
        _ => {
            let parsed = serde_json::from_str::<Value>(decision).ok()?;
            if let Some(mode) = parsed.get("plan").and_then(Value::as_str) {
                // Approve the plan and switch mode, like the terminal's "Yes, …".
                if !PLAN_MODES.contains(&mode) {
                    return None;
                }
                json!({
                    "behavior": "allow",
                    "updatedPermissions": [set_mode(mode, &ctx.permission_suggestions)],
                })
            } else if let Some(answers) = parsed.get("answers") {
                // AskUserQuestion answered on the island while the terminal
                // dialog is up: the answers ride in the tool input, exactly as
                // the terminal would have filled them in.
                if ctx.tool_name != "AskUserQuestion" || !valid_answers(answers) {
                    return None;
                }
                let mut input = ctx.tool_input.as_object().cloned()?;
                input.insert("answers".into(), answers.clone());
                return Some(
                    json!({
                        "hookSpecificOutput": {
                            "hookEventName": "PermissionRequest",
                            "decision": { "behavior": "allow", "updatedInput": Value::Object(input) },
                        }
                    })
                    .to_string(),
                );
            } else if let Some(text) = parsed.get("feedback").and_then(Value::as_str) {
                // "Tell Claude what to change": a deny whose message is the note.
                let text = text.trim();
                if text.is_empty() {
                    return None;
                }
                json!({ "behavior": "deny", "message": text })
            } else {
                return None;
            }
        }
    };
    // An allow for a plan (or any interactive tool) must hand the input back
    // unchanged, or Claude Code drops the hook's decision — the "Yes, bypass"
    // that left the terminal still asking.
    if interactive && behavior["behavior"] == "allow" {
        if ctx.tool_name == "AskUserQuestion" {
            // Allowing a question without answers would answer nothing.
            return None;
        }
        behavior["updatedInput"] = ctx.tool_input.clone();
    }
    Some(
        json!({
            "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": behavior }
        })
        .to_string(),
    )
}

/// The `setMode` update for a plan approval. Claude Code's own suggestion wins
/// when the payload carries one for that mode: it knows the right destination.
fn set_mode(mode: &str, suggestions: &serde_json::Value) -> serde_json::Value {
    suggestions
        .as_array()
        .and_then(|list| {
            list.iter().find(|s| {
                s.get("type").and_then(|t| t.as_str()) == Some("setMode")
                    && s.get("mode").and_then(|m| m.as_str()) == Some(mode)
            })
        })
        .cloned()
        .unwrap_or_else(|| serde_json::json!({ "type": "setMode", "mode": mode, "destination": "session" }))
}

/// `{"<question>": "<label>" | ["<label>", …]}` with at least one entry.
fn valid_answers(answers: &serde_json::Value) -> bool {
    let Some(map) = answers.as_object() else { return false };
    !map.is_empty()
        && map.values().all(|v| match v {
            serde_json::Value::String(_) => true,
            serde_json::Value::Array(items) => items.iter().all(serde_json::Value::is_string),
            _ => false,
        })
}

/// Reads stdin and returns the payload to forward plus what the answer needs.
fn read_event() -> Option<(String, Context)> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let map = payload.as_object_mut()?;

    // Parse argv: "coucou-hook.exe [--agent <name>] [<EventName>]"
    // --agent tags the payload with coucou_agent so the app routes to the right pill.
    // Absent or invalid names are validated and discarded by the app, not here.
    let mut agent = String::new();
    let mut arg_event = String::new();
    let mut ask = false;
    {
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            if arg == "--agent" {
                agent = it.next().unwrap_or_default();
            } else if arg == "--ask" {
                ask = true;
            } else if arg_event.is_empty() {
                arg_event = arg;
            }
        }
    }
    // --ask is only meaningful for AskUserQuestion; anything else stays a plain
    // fire-and-forget event so a misconfigured matcher can never hold a tool up.
    let ask = ask
        && map.get("tool_name").and_then(|v| v.as_str()) == Some("AskUserQuestion");
    if ask {
        map.insert("coucou_kind".into(), serde_json::Value::String("ask_user_question".into()));
    }
    // Before truncation: the answer echoes these exactly as Claude Code sent them.
    let tool_input = map.get("tool_input").cloned().unwrap_or(serde_json::Value::Null);
    let tool_name = map.get("tool_name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let permission_suggestions =
        map.get("permission_suggestions").cloned().unwrap_or(serde_json::Value::Null);
    // Which agent this hook was installed for. Absent means Claude Code,
    // so existing hook commands keep working unchanged.
    if !agent.is_empty() {
        map.insert("coucou_agent".into(), serde_json::Value::String(agent));
    }
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));

    for field in DROPPED_FIELDS {
        map.remove(*field);
    }

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Unlike macOS, Coucou here accepts
    // events from every terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
    ] {
        if !map.contains_key(key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    truncate_strings(&mut payload);

    let mut line = payload.to_string();
    line.push('\n');
    Some((line, Context { event, ask, tool_name, tool_input, permission_suggestions }))
}

/// Caps every string in the payload. A single Write can carry a whole file.
/// A `plan` field gets MAX_PLAN_LEN instead: it is what its card shows.
fn truncate_strings(value: &mut serde_json::Value) {
    truncate_with(value, MAX_FIELD_LEN);
}

fn truncate_with(value: &mut serde_json::Value, max: usize) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > max {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = max;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                let cap = if key == "plan" { MAX_PLAN_LEN } else { MAX_FIELD_LEN };
                truncate_with(v, cap);
            }
        }
        _ => {}
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::{json, Value};

    fn permission(input: Value, suggestions: Value) -> Context {
        permission_for("Bash", input, suggestions)
    }

    fn permission_for(tool: &str, input: Value, suggestions: Value) -> Context {
        Context {
            event: "PermissionRequest".into(),
            ask: false,
            tool_name: tool.into(),
            tool_input: input,
            permission_suggestions: suggestions,
        }
    }

    #[test]
    fn approving_a_plan_hands_its_input_back() {
        // Without updatedInput Claude Code ignores the hook's allow for
        // ExitPlanMode and keeps the terminal asking (the "Yes, bypass" bug).
        let input = json!({ "plan": "# Plan\n1. do it", "planFilePath": "C:/p/plan.md" });
        let ctx = permission_for("ExitPlanMode", input.clone(), Value::Null);
        for line in ["allow", r#"{"plan":"bypassPermissions"}"#, r#"{"plan":"acceptEdits"}"#] {
            let d = &out(&ctx, line)["hookSpecificOutput"]["decision"];
            assert_eq!(d["behavior"], "allow", "{line}");
            assert_eq!(d["updatedInput"], input, "{line}");
        }
        // A deny or a change note needs nothing handed back.
        assert!(out(&ctx, "deny")["hookSpecificOutput"]["decision"].get("updatedInput").is_none());
        assert!(out(&ctx, r#"{"feedback":"more tests"}"#)["hookSpecificOutput"]["decision"]
            .get("updatedInput")
            .is_none());
    }

    #[test]
    fn ordinary_tools_get_no_updated_input() {
        let ctx = permission(json!({ "command": "ls" }), Value::Null);
        assert!(out(&ctx, "allow")["hookSpecificOutput"]["decision"].get("updatedInput").is_none());
    }

    #[test]
    fn a_question_answered_on_the_island_rides_in_the_tool_input() {
        let questions = json!([{ "question": "Fruit?", "header": "F", "multiSelect": false,
            "options": [{ "label": "Apple" }, { "label": "Banana" }] }]);
        let ctx = permission_for("AskUserQuestion", json!({ "questions": questions.clone() }), Value::Null);
        let v = out(&ctx, r#"{"answers":{"Fruit?":"Banana"}}"#);
        assert_eq!(
            v,
            json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": {
                "behavior": "allow",
                "updatedInput": { "questions": questions, "answers": { "Fruit?": "Banana" } },
            }}})
        );
        // A bare allow would answer nothing: say nothing, the terminal asks.
        assert!(decision_output(&ctx, "allow").is_none());
        assert!(decision_output(&ctx, r#"{"answers":{"Fruit?":3}}"#).is_none());
        // Answers for any other tool are not a decision.
        let bash = permission(json!({}), Value::Null);
        assert!(decision_output(&bash, r#"{"answers":{"q":"a"}}"#).is_none());
    }

    fn out(ctx: &Context, line: &str) -> Value {
        serde_json::from_str(&decision_output(ctx, line).expect("an output")).unwrap()
    }

    #[test]
    fn plain_words_match_the_documented_shape() {
        let ctx = permission(json!({}), Value::Null);
        // Compared as JSON: key order is not part of the contract.
        assert_eq!(
            out(&ctx, "allow"),
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}})
        );
        assert_eq!(
            out(&ctx, "deny"),
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest",
                "decision":{"behavior":"deny","message":"Denied from Coucou"}}})
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert_eq!(out(&ctx, "always")["hookSpecificOutput"]["decision"]["behavior"], "allow");
        // Still a single line: the relay prints exactly one.
        assert!(!decision_output(&ctx, "allow").unwrap().contains('\n'));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        let ctx = permission(json!({}), Value::Null);
        assert!(decision_output(&ctx, "").is_none());
        assert!(decision_output(&ctx, "maybe").is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_output(&ctx, r#"{"permissionDecision":"allow"}"#).is_none());
        assert!(decision_output(&ctx, r#"{"plan":"yolo"}"#).is_none());
        assert!(decision_output(&ctx, r#"{"feedback":"   "}"#).is_none());
        // Answers only answer an AskUserQuestion.
        assert!(decision_output(&ctx, r#"{"answers":{"q":"a"}}"#).is_none());
    }

    #[test]
    fn plan_approval_switches_mode_for_the_session() {
        let ctx = permission_for("ExitPlanMode", json!({ "plan": "# p" }), Value::Null);
        let v = out(&ctx, r#"{"plan":"acceptEdits"}"#);
        let d = &v["hookSpecificOutput"]["decision"];
        assert_eq!(d["behavior"], "allow");
        assert_eq!(
            d["updatedPermissions"],
            json!([{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }])
        );
    }

    #[test]
    fn plan_approval_prefers_claude_codes_own_suggestion() {
        let suggestion = json!({ "type": "setMode", "mode": "bypassPermissions", "destination": "cliArg" });
        let ctx = permission_for(
            "ExitPlanMode",
            json!({}),
            json!([{ "type": "addRules", "rules": [] }, suggestion.clone()]),
        );
        let v = out(&ctx, r#"{"plan":"bypassPermissions"}"#);
        assert_eq!(v["hookSpecificOutput"]["decision"]["updatedPermissions"], json!([suggestion]));
    }

    #[test]
    fn plan_feedback_is_a_deny_carrying_the_note() {
        let ctx = permission(json!({}), Value::Null);
        let v = out(&ctx, r#"{"feedback":"  Add a test step.  "}"#);
        assert_eq!(
            v["hookSpecificOutput"]["decision"],
            json!({ "behavior": "deny", "message": "Add a test step." })
        );
    }

    #[test]
    fn ask_answers_echo_the_original_questions() {
        let questions = json!([{ "question": "Fruit?", "header": "Fruit", "multiSelect": false,
            "options": [{ "label": "Apple", "description": "" }, { "label": "Banana", "description": "" }] }]);
        let ctx = Context {
            event: "PreToolUse".into(),
            ask: true,
            tool_name: "AskUserQuestion".into(),
            tool_input: json!({ "questions": questions.clone() }),
            permission_suggestions: Value::Null,
        };
        let v = out(&ctx, r#"{"answers":{"Fruit?":"Banana","Toppings?":["a","b"]}}"#);
        assert_eq!(
            v,
            json!({ "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "updatedInput": { "questions": questions,
                    "answers": { "Fruit?": "Banana", "Toppings?": ["a", "b"] } },
            }})
        );
        // Nothing usable → nothing printed → the terminal asks.
        assert!(decision_output(&ctx, "allow").is_none());
        assert!(decision_output(&ctx, r#"{"answers":{}}"#).is_none());
        assert!(decision_output(&ctx, r#"{"answers":{"Fruit?":3}}"#).is_none());
    }

    #[test]
    fn a_long_plan_survives_truncation() {
        let plan = "x".repeat(10_000);
        let mut v = json!({ "tool_input": { "plan": plan.clone(), "other": plan } });
        truncate_strings(&mut v);
        assert_eq!(v["tool_input"]["plan"].as_str().unwrap().len(), 10_000);
        assert!(v["tool_input"]["other"].as_str().unwrap().ends_with('…'));
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }
}
