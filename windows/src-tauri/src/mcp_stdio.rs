// A minimal MCP client over stdio: start a local MCP server, call one tool,
// read its JSON result, shut the server down. No LLM anywhere in the loop: the
// tool call is fully deterministic and Coucou knows exactly which tool it wants.
//
// Transport (MCP stdio, protocol 2025-06-18): newline-delimited JSON-RPC 2.0
// on the child's stdin/stdout. The child may print anything else on stdout
// (a warning from `uv`, a banner), and may send its own notifications or
// requests (log messages, pings) between our requests. Only a line that is a
// JSON-RPC *response* carrying our id ends a wait; everything else is skipped.
//
// Lifetime: the whole exchange runs under one timeout. Afterwards stdin is
// closed (the spec's polite shutdown, which lets `uv` take its Python child
// down with it), and the child is killed if it has not exited shortly after.
// `kill_on_drop` covers every early return and the timeout path.

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};

/// The protocol version we ask for. Whatever the server answers is accepted:
/// `initialize` + `tools/call` look the same in every version since 2024-11-05.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// How long a server gets to exit on its own once stdin is closed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// Spawns `program args`, does initialize → notifications/initialized →
/// tools/call, and returns the tool's JSON result.
pub async fn call_tool(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    tool: &str,
    arguments: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    // No console window flashing up behind the island on every refresh.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Can't start {}: {e}", program.display()))?;
    let stdin = child.stdin.take().ok_or("MCP server stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("MCP server stdout unavailable")?;

    // stderr must be drained, or a chatty server (uv resolving packages) fills
    // the pipe and blocks. The last line is kept: when the server dies before
    // answering, it is usually the only clue why.
    let last_stderr = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let keep = last_stderr.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if !line.is_empty() {
                    *keep.lock().unwrap() = line.chars().take(300).collect();
                }
            }
        });
    }

    let outcome = tokio::time::timeout(timeout, exchange(stdin, stdout, tool, arguments)).await;
    shutdown(&mut child).await;

    match outcome {
        Err(_) => Err(format!("MCP server took longer than {} s.", timeout.as_secs())),
        Ok(Ok(result)) => extract_tool_result(&result),
        Ok(Err(Exchange::Rpc(msg))) => Err(msg),
        Ok(Err(Exchange::Closed(msg))) => {
            let detail = last_stderr.lock().unwrap().clone();
            Err(if detail.is_empty() { msg } else { format!("{msg}: {detail}") })
        }
    }
}

/// Why an exchange stopped short. `Closed` gets the server's stderr appended.
enum Exchange {
    Rpc(String),
    Closed(String),
}

/// The three messages of a one-shot tool call, returning the raw `tools/call`
/// result object (before `isError` / content handling).
async fn exchange(
    mut stdin: ChildStdin,
    stdout: ChildStdout,
    tool: &str,
    arguments: Value,
) -> Result<Value, Exchange> {
    let mut lines = BufReader::new(stdout).lines();

    send(&mut stdin, &request(1, "initialize", initialize_params())).await?;
    // The negotiated version and server capabilities don't change what we send.
    read_response(&mut lines, 1).await?;

    send(&mut stdin, &notification("notifications/initialized")).await?;
    let params = json!({ "name": tool, "arguments": arguments });
    send(&mut stdin, &request(2, "tools/call", params)).await?;
    read_response(&mut lines, 2).await
    // stdin drops here, which closes it: the server's cue to exit.
}

async fn send(stdin: &mut ChildStdin, line: &str) -> Result<(), Exchange> {
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| Exchange::Closed(format!("MCP server stopped reading ({e})")))?;
    stdin
        .flush()
        .await
        .map_err(|e| Exchange::Closed(format!("MCP server stopped reading ({e})")))
}

async fn read_response(
    lines: &mut tokio::io::Lines<BufReader<ChildStdout>>,
    id: u64,
) -> Result<Value, Exchange> {
    loop {
        let line = lines
            .next_line()
            .await
            .map_err(|e| Exchange::Closed(format!("Can't read the MCP server ({e})")))?
            .ok_or_else(|| Exchange::Closed("MCP server exited before answering".into()))?;
        if let Some(found) = match_response(&line, id) {
            return found.map_err(Exchange::Rpc);
        }
    }
}

/// Polite shutdown first (stdin is already closed by `exchange`), then a kill.
/// Killing `uv` outright could leave its Python child behind on Windows.
async fn shutdown(child: &mut Child) {
    // Closing stdin is what ends a stdio server; on the timeout path the
    // exchange future (and its stdin) has already been dropped.
    drop(child.stdin.take());
    if tokio::time::timeout(SHUTDOWN_GRACE, child.wait()).await.is_err() {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(SHUTDOWN_GRACE, child.wait()).await;
    }
}

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "coucou", "version": env!("CARGO_PKG_VERSION") },
    })
}

/// One JSON-RPC request, framed as a single line. serde_json never emits raw
/// newlines inside a value, so the frame can't be split by the payload.
fn request(id: u64, method: &str, params: Value) -> String {
    let mut line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
        .to_string();
    line.push('\n');
    line
}

fn notification(method: &str) -> String {
    let mut line = json!({ "jsonrpc": "2.0", "method": method }).to_string();
    line.push('\n');
    line
}

/// `Some` when `line` is the response to request `id`: `Ok(result)` or
/// `Err(error message)`. `None` for anything else: non-JSON noise, server
/// notifications, server requests (they carry a `method`, possibly with an id
/// that collides with ours), responses to other ids.
fn match_response(line: &str, id: u64) -> Option<Result<Value, String>> {
    let msg: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = msg.as_object()?;
    if obj.contains_key("method") || obj.get("id")?.as_u64()? != id {
        return None;
    }
    if let Some(err) = obj.get("error") {
        let text = err
            .get("message")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("MCP server returned an error.");
        return Some(Err(text.to_string()));
    }
    Some(Ok(obj.get("result").cloned().unwrap_or(Value::Null)))
}

/// The tool's JSON out of a `tools/call` result.
///
/// - `isError` → the text of the content, verbatim (the server's own message,
///   e.g. "Belum login ke Space…", is the most useful thing to show).
/// - `structuredContent` wins when present. Python MCP servers wrap a non-object
///   return as `{"result": …}`; a lone `result` key is unwrapped.
/// - Otherwise the first text block, parsed as JSON.
fn extract_tool_result(result: &Value) -> Result<Value, String> {
    if result.get("isError").and_then(Value::as_bool).unwrap_or(false) {
        let text = content_text(result);
        return Err(if text.is_empty() { "The tool returned an error.".into() } else { text });
    }
    if let Some(structured) = result.get("structuredContent").filter(|v| !v.is_null()) {
        if let Some(obj) = structured.as_object() {
            if obj.len() == 1 {
                if let Some(inner) = obj.get("result") {
                    return Ok(inner.clone());
                }
            }
        }
        return Ok(structured.clone());
    }
    let first = result
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| blocks.first())
        .and_then(|b| b.get("text"))
        .and_then(Value::as_str)
        .ok_or("The tool returned no content.")?;
    serde_json::from_str(first).map_err(|_| "The tool returned something that isn't JSON.".to_string())
}

/// Every text block of a result's `content`, joined.
fn content_text(result: &Value) -> String {
    result
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_is_one_jsonrpc_line() {
        let line = request(7, "tools/call", json!({ "name": "t", "arguments": { "s": "a\nb" } }));
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1, "payload newlines must stay escaped");
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 7);
        assert_eq!(v["method"], "tools/call");
        assert_eq!(v["params"]["arguments"]["s"], "a\nb");
    }

    #[test]
    fn notification_has_no_id() {
        let v: Value = serde_json::from_str(notification("notifications/initialized").trim()).unwrap();
        assert_eq!(v["method"], "notifications/initialized");
        assert!(v.get("id").is_none());
    }

    #[test]
    fn initialize_names_coucou_and_the_protocol() {
        let p = initialize_params();
        assert_eq!(p["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(p["clientInfo"]["name"], "coucou");
        assert_eq!(p["clientInfo"]["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn response_is_found_among_noise() {
        let stream = [
            "Installed 3 packages in 12ms",
            "",
            "{not json",
            r#"{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}"#,
            r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":1,"result":{"other":true}}"#,
            r#"{"jsonrpc":"2.0","id":2,"result":{"ok":1}}"#,
        ];
        let found: Vec<_> = stream.iter().filter_map(|l| match_response(l, 2)).collect();
        assert_eq!(found, vec![Ok(json!({ "ok": 1 }))]);
    }

    #[test]
    fn response_ignores_string_ids_and_arrays() {
        assert_eq!(match_response(r#"{"jsonrpc":"2.0","id":"2","result":{}}"#, 2), None);
        assert_eq!(match_response(r#"[{"jsonrpc":"2.0","id":2,"result":{}}]"#, 2), None);
    }

    #[test]
    fn response_error_carries_the_message() {
        let line = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Unknown tool: x"}}"#;
        assert_eq!(match_response(line, 1), Some(Err("Unknown tool: x".into())));
        let bare = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32603}}"#;
        assert_eq!(match_response(bare, 1), Some(Err("MCP server returned an error.".into())));
    }

    #[test]
    fn tool_result_prefers_structured_content() {
        let r = json!({
            "content": [{ "type": "text", "text": "{\"days\":[]}" }],
            "structuredContent": { "user_auth_id": 1, "days": [1] },
        });
        assert_eq!(extract_tool_result(&r).unwrap(), json!({ "user_auth_id": 1, "days": [1] }));
    }

    #[test]
    fn tool_result_unwraps_a_lone_result_key() {
        let r = json!({ "content": [], "structuredContent": { "result": [1, 2] } });
        assert_eq!(extract_tool_result(&r).unwrap(), json!([1, 2]));
        // A dict that merely contains `result` among other keys is left alone.
        let r = json!({ "structuredContent": { "result": 1, "more": 2 } });
        assert_eq!(extract_tool_result(&r).unwrap(), json!({ "result": 1, "more": 2 }));
    }

    #[test]
    fn tool_result_falls_back_to_text_json() {
        let r = json!({ "content": [{ "type": "text", "text": " {\"a\": 1} " }] });
        assert_eq!(extract_tool_result(&r).unwrap(), json!({ "a": 1 }));
    }

    #[test]
    fn tool_error_text_comes_back_verbatim() {
        let msg = "Belum login ke Space. Jalankan di terminal: space-timebox login";
        let r = json!({ "isError": true, "content": [{ "type": "text", "text": msg }] });
        assert_eq!(extract_tool_result(&r).unwrap_err(), msg);
        let r = json!({ "isError": true, "content": [] });
        assert_eq!(extract_tool_result(&r).unwrap_err(), "The tool returned an error.");
    }

    #[test]
    fn tool_result_malformed() {
        assert!(extract_tool_result(&json!({})).is_err());
        assert!(extract_tool_result(&json!({ "content": [] })).is_err());
        assert!(extract_tool_result(&json!({ "content": [{ "type": "text", "text": "hello" }] })).is_err());
        assert!(extract_tool_result(&json!({ "content": [{ "type": "image", "data": "…" }] })).is_err());
        // Null structuredContent is the same as absent.
        let r = json!({ "structuredContent": null, "content": [{ "type": "text", "text": "[]" }] });
        assert_eq!(extract_tool_result(&r).unwrap(), json!([]));
    }
}
