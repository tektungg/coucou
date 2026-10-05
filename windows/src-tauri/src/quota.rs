// Claude Code usage: rate limits (5-hour and 7-day windows), context and cost
// per session, read from the small status files the user's status line writes.
//
// Claude Code hands its status line command a JSON blob on every render,
// including `rate_limits`. Nothing else exposes those numbers locally, so a
// tiny addition to the status line script (statusline-coucou.js) drops one
// file per session into %LOCALAPPDATA%\Coucou\status\<session_id>.json:
//   {session_id, cwd, model, ctx_pct, cost_usd,
//    five_hour: {pct, resets_at} | null, seven_day: {pct, resets_at} | null,
//    ts}                      ts = unix ms, resets_at = unix seconds
// Files are replaced atomically (written to a temp name, then renamed), so a
// reader never sees half a file; a corrupt one is skipped anyway.
//
// Rate limits are per account, not per session, so they come from the newest
// file that has them. Sessions that stopped rendering for a day are swept.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

use crate::settings;

/// Status files untouched for this long belong to sessions long gone.
const STALE_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub pct: f64,
    /// Unix seconds, as Claude Code gives it. 0 when unknown.
    pub resets_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub session_id: String,
    pub cwd: String,
    pub model: String,
    pub ctx_pct: f64,
    pub cost_usd: f64,
    /// Unix ms of the last status line render.
    pub ts: i64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    pub five_hour: Option<Limit>,
    pub seven_day: Option<Limit>,
    /// Newest first.
    pub sessions: Vec<SessionUsage>,
    pub total_cost: f64,
    /// Unix ms of the newest file, 0 when there is none.
    pub updated: i64,
}

/// %LOCALAPPDATA%\Coucou\status
pub fn status_dir() -> PathBuf {
    settings::local_dir().join("status")
}

/// Reads every status file in `dir` and deletes the stale ones (by file time
/// or by the `ts` inside). A missing directory is an empty snapshot: the status
/// line simply hasn't run yet.
pub fn read_dir(dir: &Path, now_ms: i64) -> QuotaSnapshot {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return QuotaSnapshot::default();
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // `.json` files, plus the writer's temp files so a crash mid-write
        // doesn't leave them behind forever.
        let is_status = name.ends_with(".json");
        if !(is_status || name.ends_with(".tmp")) || !path.is_file() {
            continue;
        }
        let modified_ms = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        if modified_ms.is_some_and(|m| now_ms - m > STALE_MS) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        if !is_status {
            continue;
        }
        let Some(value) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        else {
            continue;
        };
        if ts_of(&value).is_some_and(|ts| now_ms - ts > STALE_MS) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        files.push(value);
    }
    snapshot_from(files, now_ms)
}

/// The snapshot from already-parsed files. Entries without a session id or a
/// timestamp are ignored; missing numbers count as 0.
pub fn snapshot_from(files: Vec<Value>, now_ms: i64) -> QuotaSnapshot {
    let mut entries: Vec<(SessionUsage, &Value)> = files
        .iter()
        .filter_map(|v| session(v).map(|s| (s, v)))
        .collect();
    // Newest first; ties broken by id so the order is stable between reads.
    entries.sort_by(|a, b| b.0.ts.cmp(&a.0.ts).then_with(|| a.0.session_id.cmp(&b.0.session_id)));

    let now_s = now_ms / 1000;
    let newest_limit = |key: &str| {
        entries
            .iter()
            .find_map(|(_, v)| limit(v.get(key)))
            // A window that has already reset says nothing about the new one:
            // better no number than a stale 95 %.
            .filter(|l| l.resets_at == 0 || l.resets_at > now_s)
    };
    let five_hour = newest_limit("five_hour");
    let seven_day = newest_limit("seven_day");

    let sessions: Vec<SessionUsage> = entries.into_iter().map(|(s, _)| s).collect();
    QuotaSnapshot {
        five_hour,
        seven_day,
        total_cost: sessions.iter().map(|s| s.cost_usd).sum(),
        updated: sessions.first().map(|s| s.ts).unwrap_or(0),
        sessions,
    }
}

fn session(v: &Value) -> Option<SessionUsage> {
    let session_id = v.get("session_id")?.as_str()?.trim();
    if session_id.is_empty() {
        return None;
    }
    let text = |key: &str| v.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    Some(SessionUsage {
        session_id: session_id.to_string(),
        cwd: text("cwd"),
        model: text("model"),
        ctx_pct: num(v.get("ctx_pct")).unwrap_or(0.0),
        cost_usd: num(v.get("cost_usd")).unwrap_or(0.0),
        ts: ts_of(v)?,
    })
}

fn limit(v: Option<&Value>) -> Option<Limit> {
    let v = v?;
    Some(Limit {
        pct: num(v.get("pct"))?,
        resets_at: num(v.get("resets_at")).map(|n| n as i64).unwrap_or(0),
    })
}

fn ts_of(v: &Value) -> Option<i64> {
    num(v.get("ts")).map(|n| n as i64).filter(|&n| n > 0)
}

fn num(v: Option<&Value>) -> Option<f64> {
    v?.as_f64().filter(|n| n.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_790_000_000_000; // ms
    const NOW_S: i64 = NOW / 1000;

    fn file(id: &str, ts: i64, cost: f64, five: Value, seven: Value) -> Value {
        json!({ "session_id": id, "cwd": "C:/p", "model": "Opus 5.5", "ctx_pct": 12.5,
                "cost_usd": cost, "five_hour": five, "seven_day": seven, "ts": ts })
    }

    fn lim(pct: f64, resets_at: i64) -> Value {
        json!({ "pct": pct, "resets_at": resets_at })
    }

    #[test]
    fn newest_limits_win_and_sessions_are_newest_first() {
        let files = vec![
            file("old", NOW - 60_000, 1.0, lim(10.0, NOW_S + 3600), lim(50.0, NOW_S + 86_400)),
            file("new", NOW - 1_000, 2.0, lim(30.0, NOW_S + 3000), lim(55.0, NOW_S + 86_000)),
            file("mid", NOW - 30_000, 0.5, lim(20.0, NOW_S + 3300), Value::Null),
        ];
        let s = snapshot_from(files, NOW);
        assert_eq!(s.five_hour, Some(Limit { pct: 30.0, resets_at: NOW_S + 3000 }));
        assert_eq!(s.seven_day, Some(Limit { pct: 55.0, resets_at: NOW_S + 86_000 }));
        let ids: Vec<&str> = s.sessions.iter().map(|x| x.session_id.as_str()).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
        assert_eq!(s.updated, NOW - 1_000);
        assert!((s.total_cost - 3.5).abs() < 1e-9);
        assert_eq!(s.sessions[0].model, "Opus 5.5");
        assert_eq!(s.sessions[0].ctx_pct, 12.5);
    }

    #[test]
    fn a_limit_missing_from_the_newest_file_comes_from_the_next() {
        let files = vec![
            file("a", NOW - 5_000, 0.0, lim(40.0, NOW_S + 100), lim(70.0, NOW_S + 1000)),
            file("b", NOW - 1_000, 0.0, Value::Null, json!({ "pct": "bad" })),
        ];
        let s = snapshot_from(files, NOW);
        assert_eq!(s.five_hour.unwrap().pct, 40.0);
        assert_eq!(s.seven_day.unwrap().pct, 70.0);
    }

    #[test]
    fn a_window_that_already_reset_is_dropped() {
        let files = vec![file("a", NOW - 1_000, 0.0, lim(95.0, NOW_S - 10), lim(10.0, 0))];
        let s = snapshot_from(files, NOW);
        assert_eq!(s.five_hour, None);
        assert_eq!(s.seven_day, Some(Limit { pct: 10.0, resets_at: 0 }));
    }

    #[test]
    fn partial_and_corrupt_entries_are_ignored() {
        let files = vec![
            json!({ "cwd": "x", "ts": NOW }),                           // no session id
            json!({ "session_id": "", "ts": NOW }),                     // empty id
            json!({ "session_id": "nots" }),                            // no ts
            json!({ "session_id": "badts", "ts": "yesterday" }),        // ts not a number
            json!([1, 2, 3]),                                           // not an object
            json!({ "session_id": "min", "ts": NOW - 10 }),             // minimal but valid
        ];
        let s = snapshot_from(files, NOW);
        assert_eq!(s.sessions.len(), 1);
        let only = &s.sessions[0];
        assert_eq!((only.session_id.as_str(), only.cost_usd, only.model.as_str()), ("min", 0.0, ""));
        assert_eq!(s.five_hour, None);
    }

    #[test]
    fn empty_input_is_the_default_snapshot() {
        assert_eq!(snapshot_from(vec![], NOW), QuotaSnapshot::default());
    }

    #[test]
    fn serializes_camel_case() {
        let s = snapshot_from(vec![file("a", NOW, 1.0, lim(1.0, NOW_S + 5), Value::Null)], NOW);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["fiveHour"]["resetsAt"], NOW_S + 5);
        assert!(v["sevenDay"].is_null());
        assert_eq!(v["sessions"][0]["sessionId"], "a");
        assert_eq!(v["totalCost"], 1.0);
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coucou-quota-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_dir_reads_sweeps_and_skips_corrupt_files() {
        let dir = temp_dir("sweep");
        let now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let write = |name: &str, v: &Value| std::fs::write(dir.join(name), v.to_string()).unwrap();

        write("fresh.json", &file("fresh", now - 1_000, 1.5, lim(12.0, now / 1000 + 600), Value::Null));
        // Old by its own timestamp.
        write("old-ts.json", &file("old-ts", now - STALE_MS - 1, 9.0, lim(99.0, 0), Value::Null));
        // Old by file time, though its content claims to be fresh.
        write("old-mtime.json", &file("old-mtime", now, 9.0, Value::Null, Value::Null));
        let day_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 3600);
        std::fs::File::options()
            .write(true)
            .open(dir.join("old-mtime.json"))
            .unwrap()
            .set_modified(day_ago)
            .unwrap();
        // A leftover temp file from a crashed write, also a day old.
        std::fs::write(dir.join("x.json.123.tmp"), "{").unwrap();
        std::fs::File::options()
            .write(true)
            .open(dir.join("x.json.123.tmp"))
            .unwrap()
            .set_modified(day_ago)
            .unwrap();
        // A fresh temp file (a write in progress) and a corrupt file stay put.
        std::fs::write(dir.join("y.json.456.tmp"), "{\"session_id\":").unwrap();
        std::fs::write(dir.join("corrupt.json"), "{\"session_id\": \"c\", ").unwrap();
        std::fs::write(dir.join("notes.txt"), "ignored").unwrap();

        let s = read_dir(&dir, now);
        let ids: Vec<&str> = s.sessions.iter().map(|x| x.session_id.as_str()).collect();
        assert_eq!(ids, vec!["fresh"]);
        assert_eq!(s.five_hour.as_ref().map(|l| l.pct), Some(12.0));
        assert!((s.total_cost - 1.5).abs() < 1e-9);

        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(left, vec!["corrupt.json", "fresh.json", "notes.txt", "y.json.456.tmp"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_dir_of_a_missing_folder_is_empty() {
        let dir = std::env::temp_dir().join(format!("coucou-quota-missing-{}", std::process::id()));
        assert_eq!(read_dir(&dir, NOW), QuotaSnapshot::default());
    }

    /// Live eval: reads the files the real status line wrote. Prints numbers
    /// only. Run with `cargo test -p coucou --lib quota_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn quota_live() {
        let now = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let s = read_dir(&status_dir(), now);
        println!(
            "sessions {} | 5h {:?} | 7d {:?} | total ${:.2} | updated {} s ago",
            s.sessions.len(),
            s.five_hour.as_ref().map(|l| (l.pct, l.resets_at)),
            s.seven_day.as_ref().map(|l| (l.pct, l.resets_at)),
            s.total_cost,
            (now - s.updated) / 1000
        );
        assert!(!s.sessions.is_empty(), "no status files: is the status line writing them?");
    }

    #[test]
    fn status_dir_is_under_local_dir() {
        assert_eq!(status_dir(), settings::local_dir().join("status"));
    }
}
