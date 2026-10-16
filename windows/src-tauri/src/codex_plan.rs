// Codex plan usage: the same source as CodexPlanGauge.swift on the Mac. Ported
// from upstream (Louis-CFM/coucou c02923e, and the process tree fix of 5bddaec).
//
// Coucou asks the Codex CLI itself: `codex app-server` (the JSON-RPC server
// behind Codex's /status) is started, asked `account/rateLimits/read`, and
// stopped. Coucou makes no network call of its own and reads no credential:
// Codex answers with its own sign-in, exactly as /status does, and nothing is
// installed or written. It runs only when the island's Codex pill shows or is
// clicked (views/planState.ts), at most once at a time, for 15 s at most, and
// is skipped while Coucou is paused.
//
// The CLI is looked for here rather than in platform/: on PATH, then in the
// usual per-user install folders a desktop launch often leaves out of PATH.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{self, AtomicBool};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::platform;

/// The Mac gives Codex the same 15 s.
const TIMEOUT: Duration = Duration::from_secs(15);
/// One JSON-RPC line we are willing to read; the answer is a few hundred bytes.
const MAX_LINE: usize = 256 * 1024;
/// Everything we are willing to read before the answer shows up.
const MAX_TOTAL: usize = 2 * 1024 * 1024;
/// The id of the one question in REQUESTS.
const ANSWER_ID: i64 = 2;

/// What the Mac sends: initialize, initialized, then the one question.
const REQUESTS: &str = concat!(
    r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"coucou","version":"1"}}}"#,
    "\n",
    r#"{"method":"initialized"}"#,
    "\n",
    r#"{"id":2,"method":"account/rateLimits/read"}"#,
    "\n",
);

static BUSY: AtomicBool = AtomicBool::new(false);

struct NotBusy;
impl Drop for NotBusy {
    fn drop(&mut self) {
        BUSY.store(false, atomic::Ordering::Release);
    }
}

/// The Codex pill's numbers, asked of the Codex CLI. Off the main thread: it
/// can take a few seconds.
#[tauri::command]
pub async fn codex_plan_usage() -> Option<Value> {
    tauri::async_runtime::spawn_blocking(read).await.ok().flatten()
}

/// The limits part of Codex's `account/rateLimits/read` answer, or `None` when
/// Codex is not installed, not signed in, slow, already being asked, or Coucou
/// is paused. Blocking: call it off the main thread.
pub fn read() -> Option<Value> {
    if crate::integrations::PAUSED.load(atomic::Ordering::Relaxed) {
        return None;
    }
    if BUSY.swap(true, atomic::Ordering::AcqRel) {
        return None;
    }
    let _busy = NotBusy;

    let exe = codex_candidates().into_iter().next()?;
    let mut child = spawn_app_server(&exe)?;
    let answer = ask(&mut child);
    end(&mut child);
    answer.map(|result| limits_only(&result))
}

fn spawn_app_server(exe: &Path) -> Option<Child> {
    let mut cmd = Command::new(exe);
    cmd.arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(path) = path_with(exe.parent()) {
        cmd.env("PATH", path);
    }
    platform::no_console(&mut cmd);
    cmd.spawn().ok()
}

/// An npm install is a `#!/usr/bin/env node` script (or a .cmd calling node):
/// its own folder goes first on PATH, as the Mac does, so it finds its Node.
fn path_with(dir: Option<&Path>) -> Option<OsString> {
    let mut dirs = vec![dir?.to_path_buf()];
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(dirs).ok()
}

/// Sends the three requests and waits (15 s at most) for the answer.
fn ask(child: &mut Child) -> Option<Value> {
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(first_answer(BufReader::new(stdout)));
    });
    stdin.write_all(REQUESTS.as_bytes()).ok()?;
    stdin.flush().ok()?;
    let answer = rx.recv_timeout(TIMEOUT).ok().flatten();
    // Closing its input is how app-server learns we are done.
    drop(stdin);
    answer
}

/// Stops app-server. An npm install runs `codex.cmd` on Windows: killing
/// cmd.exe alone would leave the node app-server under it running (and the
/// reader thread waiting on its pipe), so the whole tree ends there.
fn end(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut kill = Command::new(taskkill());
        kill.args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        platform::no_console(&mut kill);
        let _ = kill.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// System32's taskkill, never one that happens to sit on PATH first.
#[cfg(windows)]
fn taskkill() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32").join("taskkill.exe"))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("taskkill"))
}

/// Reads JSON-RPC lines until the answer to the question and returns its
/// `result`. Gives up on a line or a stream that is far too long for what we
/// expect, and on an error answer.
pub fn first_answer(reader: impl BufRead) -> Option<Value> {
    let mut reader = reader;
    let mut total = 0usize;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = (&mut reader).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line).ok()?;
        if n == 0 {
            return None;
        }
        total += n;
        if total > MAX_TOTAL || line.len() > MAX_LINE {
            return None;
        }
        let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
        if message.get("id").and_then(Value::as_i64) == Some(ANSWER_ID) {
            return message.get("result").filter(|r| r.is_object()).cloned();
        }
    }
}

/// Only what the card shows goes to the webview: the limits and the free resets.
fn limits_only(result: &Value) -> Value {
    json!({
        "rateLimits": result.get("rateLimits").cloned().unwrap_or(Value::Null),
        "rateLimitResetCredits": result.get("rateLimitResetCredits").cloned().unwrap_or(Value::Null),
    })
}

// ── Where the Codex CLI is ────────────────────────────────────────────────────

/// The candidates `keep` accepts, each once (PATH often names a fixed folder too), in order.
fn keep_unique(mut out: Vec<PathBuf>, keep: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    out.retain(|p| keep(p) && seen.insert(p.clone()));
    out
}

/// What Windows can start directly; npm also leaves `codex.ps1` and a bare
/// `codex` shell script next to `codex.cmd`.
#[cfg(windows)]
const RUNNABLE: [&str; 4] = ["exe", "cmd", "bat", "com"];

/// Where the Codex CLI may be, best first: %PATH% (codex.exe or npm's
/// codex.cmd), then npm's global folder, OpenAI's installer and the
/// Volta / Bun / pnpm ones.
/// Rust quotes the one fixed argument safely for a `.cmd` (see find_on_path).
#[cfg(windows)]
pub fn codex_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = platform::find_on_path("codex").into_iter().collect();
    let var = |k: &str| std::env::var_os(k).map(PathBuf::from).filter(|p| p.is_absolute());
    if let Some(appdata) = var("APPDATA") {
        out.push(appdata.join("npm").join("codex.cmd"));
    }
    if let Some(local) = var("LOCALAPPDATA") {
        // OpenAI's own installer.
        out.push(local.join("Programs").join("OpenAI").join("Codex").join("bin").join("codex.exe"));
        out.push(local.join("Volta").join("bin").join("codex.exe"));
        out.push(local.join("pnpm").join("codex.cmd"));
    }
    if let Some(home) = var("USERPROFILE") {
        out.push(home.join(".bun").join("bin").join("codex.exe"));
        out.push(home.join(".local").join("bin").join("codex.exe"));
    }
    keep_unique(out, |p| p.is_file() && runnable(p))
}

#[cfg(windows)]
fn runnable(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| RUNNABLE.iter().any(|r| r.eq_ignore_ascii_case(e)))
}

/// Per-user folders under $HOME a desktop launch often leaves out of $PATH:
/// npm's global prefix, Volta, Bun and pnpm.
#[cfg(unix)]
const HOME_BIN_DIRS: [&str; 5] = [".local/bin", ".npm-global/bin", ".volta/bin", ".bun/bin", ".local/share/pnpm"];

/// Where the Codex CLI may be, best first: $PATH, then the usual per-user
/// install folders, the system ones, and nvm with its newest Node first.
#[cfg(unix)]
pub fn codex_candidates() -> Vec<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    const EXEC_BITS: u32 = 0o111;

    let home = platform::home_dir();
    let mut out: Vec<PathBuf> = platform::find_on_path("codex").into_iter().collect();
    out.extend(HOME_BIN_DIRS.iter().map(|dir| home.join(dir).join("codex")));
    out.push(PathBuf::from("/usr/local/bin/codex"));
    out.push(PathBuf::from("/usr/bin/codex"));
    out.extend(nvm_candidates(&home.join(".nvm/versions/node")));
    keep_unique(out, |p| {
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & EXEC_BITS != 0)
            .unwrap_or(false)
    })
}

/// `codex` of every Node nvm installed, the newest Node first.
#[cfg(unix)]
fn nvm_candidates(nvm: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(nvm) else { return Vec::new() };
    let mut versions: Vec<String> = entries.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
    versions.sort_by(|a, b| compare_versions(b, a));
    versions.iter().map(|v| nvm.join(v).join("bin/codex")).collect()
}

/// A version-like name cut into its runs of digits (as numbers) and of the rest.
#[cfg_attr(windows, allow(dead_code))]
fn version_parts(s: &str) -> Vec<Result<u64, String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut digits = false;
    let mut flush = |cur: &mut String, digits: bool| {
        if !cur.is_empty() {
            out.push(if digits { Ok(cur.parse().unwrap_or(u64::MAX)) } else { Err(cur.clone()) });
            cur.clear();
        }
    };
    for c in s.chars() {
        if c.is_ascii_digit() != digits {
            flush(&mut cur, digits);
        }
        digits = c.is_ascii_digit();
        cur.push(c);
    }
    flush(&mut cur, digits);
    out
}

#[cfg_attr(windows, allow(dead_code))]
fn compare_part(x: &Result<u64, String>, y: &Result<u64, String>) -> Ordering {
    match (x, y) {
        (Ok(x), Ok(y)) => x.cmp(y),
        (Err(x), Err(y)) => x.cmp(y),
        (Ok(_), Err(_)) => Ordering::Less,
        (Err(_), Ok(_)) => Ordering::Greater,
    }
}

/// Compares version-like names with their numbers as numbers ("v20.1" > "v9.12"),
/// like Foundation's `.numeric` comparison the Mac sorts nvm's folders with.
#[cfg_attr(windows, allow(dead_code))]
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let (pa, pb) = (version_parts(a), version_parts(b));
    pa.iter()
        .zip(pb.iter())
        .map(|(x, y)| compare_part(x, y))
        .find(|ord| *ord != Ordering::Equal)
        .unwrap_or_else(|| pa.len().cmp(&pb.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_to_the_question_is_picked_out_of_the_conversation() {
        let stream = concat!(
            r#"{"id":1,"result":{"userAgent":"codex"}}"#, "\n",
            "not json at all\n",
            r#"{"method":"account/updated","params":{}}"#, "\n",
            r#"{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":12.5,"resetsAt":1900000000}}}}"#, "\n",
            r#"{"id":3,"result":{}}"#, "\n",
        );
        let result = first_answer(stream.as_bytes()).unwrap();
        assert_eq!(result["rateLimits"]["primary"]["usedPercent"], 12.5);
    }

    #[test]
    fn an_error_a_closed_stream_or_a_flood_is_no_answer() {
        assert!(first_answer(r#"{"id":2,"error":{"message":"not signed in"}}"#.as_bytes()).is_none());
        assert!(first_answer(r#"{"id":1,"result":{}}"#.as_bytes()).is_none());
        assert!(first_answer(&b""[..]).is_none());
        let huge = "x".repeat(MAX_LINE + 10);
        assert!(first_answer(format!("{huge}\n{}\n", r#"{"id":2,"result":{}}"#).as_bytes()).is_none());
        // Many short lines add up too.
        let chatter = format!("{}\n", "y".repeat(1000)).repeat(MAX_TOTAL / 1000 + 10);
        assert!(first_answer(chatter.as_bytes()).is_none());
    }

    #[test]
    fn a_result_that_is_not_an_object_is_no_answer() {
        assert!(first_answer(r#"{"id":2,"result":"ok"}"#.as_bytes()).is_none());
        assert!(first_answer(r#"{"id":2,"result":null}"#.as_bytes()).is_none());
    }

    #[test]
    fn only_the_limits_reach_the_webview() {
        let result = json!({
            "rateLimits": { "planType": "plus" },
            "rateLimitResetCredits": { "availableCount": 1 },
            "account": { "email": "me@example.com" }
        });
        let kept = limits_only(&result);
        assert_eq!(kept["rateLimits"]["planType"], "plus");
        assert_eq!(kept["rateLimitResetCredits"]["availableCount"], 1);
        assert!(kept.get("account").is_none());
        let empty = limits_only(&json!({}));
        assert!(empty["rateLimits"].is_null() && empty["rateLimitResetCredits"].is_null());
    }

    #[test]
    fn the_requests_are_initialize_initialized_then_the_question() {
        let lines: Vec<Value> = REQUESTS.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["method"], "initialize");
        assert_eq!(lines[1]["method"], "initialized");
        assert!(lines[1].get("id").is_none(), "a notification has no id");
        assert_eq!(lines[2]["method"], "account/rateLimits/read");
        assert_eq!(lines[2]["id"].as_i64(), Some(ANSWER_ID));
    }

    #[test]
    fn newest_node_first_like_the_mac() {
        let mut v = vec!["v9.12.0", "v20.1.0", "v18.20.4", "v20.11.1"];
        v.sort_by(|a, b| compare_versions(b, a));
        assert_eq!(v, ["v20.11.1", "v20.1.0", "v18.20.4", "v9.12.0"]);
        assert_eq!(compare_versions("v20", "v20.0"), Ordering::Less);
        assert_eq!(compare_versions("lts", "v1"), Ordering::Less);
        assert_eq!(compare_versions("1", "a"), Ordering::Less);
    }

    #[test]
    fn the_cli_folder_goes_first_on_path() {
        let dir = std::env::temp_dir();
        let path = path_with(Some(&dir)).unwrap();
        assert_eq!(std::env::split_paths(&path).next(), Some(dir));
        assert!(path_with(None).is_none());
    }

    #[test]
    fn candidates_are_files_that_exist_each_once() {
        let found = codex_candidates();
        for p in &found {
            assert!(p.is_file(), "{} is not a file", p.display());
        }
        assert_eq!(found.iter().collect::<HashSet<_>>().len(), found.len());
    }

    #[test]
    fn a_candidate_is_kept_once_in_its_first_place() {
        let paths = ["b", "a", "b", "skip", "a"].map(PathBuf::from).to_vec();
        let kept = keep_unique(paths, |p| p != Path::new("skip"));
        assert_eq!(kept, ["b", "a"].map(PathBuf::from).to_vec());
    }

    #[cfg(windows)]
    #[test]
    fn only_what_windows_can_start_is_a_candidate() {
        assert!(runnable(Path::new(r"C:\npm\codex.cmd")));
        assert!(runnable(Path::new(r"C:\Volta\codex.EXE")));
        assert!(!runnable(Path::new(r"C:\npm\codex.ps1")));
        assert!(!runnable(Path::new(r"C:\npm\codex")));
    }

    #[test]
    fn a_second_ask_while_one_runs_is_refused() {
        BUSY.store(true, atomic::Ordering::Release);
        let answer = read();
        BUSY.store(false, atomic::Ordering::Release);
        assert!(answer.is_none());
    }
}
