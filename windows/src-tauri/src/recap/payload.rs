// Reading a hook payload for the weekly recap: which agent and project, which
// file a tool changed and by how many lines. Never a command, a path kept, or
// file contents. Part of recap/ (see mod.rs).

use serde_json::Value;

/// Names longer than this are cut.
pub(super) const MAX_NAME_CHARS: usize = 64;
/// Same limits as DiffEngine.swift: beyond them, lines are counted, not diffed.
const DIFF_MAX_BYTES: usize = 200 * 1024;
const DIFF_MAX_LINES: usize = 4000;
const DIFF_MAX_CELLS: usize = 1_000_000;

pub(super) fn text<'a>(payload: &'a Value, key: &str) -> &'a str {
    payload.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Same routing as hooks.ts: a valid `coucou_agent` → `agent_<name>`, anything
/// else → the Claude Code pill. "claude" is reserved.
pub(super) fn agent_id(payload: &Value) -> String {
    let raw = text(payload, "coucou_agent");
    let valid = !raw.is_empty()
        && raw.len() <= 24
        && raw != "claude"
        && raw.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if valid { format!("agent_{raw}") } else { "integration_claude".to_string() }
}

/// Concurrent sessions are tracked apart; one without an ID is keyed by its
/// agent and folder, as HookServer.swift does.
pub(super) fn session_key(payload: &Value, agent: &str) -> String {
    let id = text(payload, "session_id");
    if id.is_empty() || id == "unknown" {
        format!("{agent}+{}", text(payload, "cwd"))
    } else {
        id.to_string()
    }
}

/// The working folder's last component — the only part of a path ever kept.
pub(super) fn project_name(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', '\\']).next().unwrap_or_default();
    clean_name(last)
}

fn clean_name(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).take(MAX_NAME_CHARS).collect()
}

/// The file an Edit, MultiEdit or Write touched, with lines added and removed.
pub(super) fn file_change(tool: &str, input: &Value) -> Option<(String, u32, u32)> {
    let path = input.get("file_path").and_then(Value::as_str)?;
    let (added, removed) = match tool {
        "Edit" => {
            let old = input.get("old_string").and_then(Value::as_str)?;
            let new = input.get("new_string").and_then(Value::as_str)?;
            line_diff(old, new)
        }
        "MultiEdit" => {
            let edits = input.get("edits").and_then(Value::as_array)?;
            edits.iter().fold((0u32, 0u32), |(a, r), edit| {
                let old = edit.get("old_string").and_then(Value::as_str).unwrap_or_default();
                let new = edit.get("new_string").and_then(Value::as_str).unwrap_or_default();
                let (da, dr) = line_diff(old, new);
                (a.saturating_add(da), r.saturating_add(dr))
            })
        }
        "Write" => {
            let content = input.get("content").and_then(Value::as_str)?;
            (count(split_lines(content).len()), 0)
        }
        _ => return None,
    };
    (added > 0 || removed > 0).then(|| (path.to_string(), added, removed))
}

fn count(n: usize) -> u32 {
    n.min(u32::MAX as usize) as u32
}

/// DiffEngine.splitLines: CRLF → LF, no trailing empty line.
fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

/// Lines added and removed between `old` and `new`, from their longest common
/// subsequence — the counts DiffEngine.fromEdit gives. Past its size limits
/// every old line counts as removed and every new one as added.
pub(super) fn line_diff(old: &str, new: &str) -> (u32, u32) {
    let a = split_lines(old);
    let b = split_lines(new);
    let fallback = (count(b.len()), count(a.len()));
    if old.len() + new.len() > DIFF_MAX_BYTES
        || a.len() + b.len() > DIFF_MAX_LINES
        || a.len().saturating_mul(b.len()) > DIFF_MAX_CELLS
    {
        return fallback;
    }
    let mut prev = vec![0usize; b.len() + 1];
    let mut row = vec![0usize; b.len() + 1];
    for x in &a {
        for (j, y) in b.iter().enumerate() {
            row[j + 1] = if x == y { prev[j] + 1 } else { prev[j + 1].max(row[j]) };
        }
        std::mem::swap(&mut prev, &mut row);
    }
    let lcs = prev[b.len()];
    (count(b.len() - lcs), count(a.len() - lcs))
}

pub(super) fn is_week_key(week: &str) -> bool {
    week.len() == 10
        && week.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() })
}
