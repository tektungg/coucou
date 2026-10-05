// Today's Space tasks (Venturo), read through the user's local `space-timebox`
// MCP server: `uv --directory <dir> run space-timebox serve`.
//
// Coucou never sees the Space credentials. The server keeps them in the
// Windows Credential Manager and refreshes its own token; Coucou only starts
// it, calls `list_timebox` for today and reads the summary back. If the user
// isn't signed in, the server's own message ("Belum login ke Space…") is what
// comes back as the error, verbatim.
//
// What `list_timebox` returns (space_timebox/service.py, checked 2026-10-05):
//   {user_auth_id, days: [{date, summary: {total_point, total_done, …} | null,
//                          items: [{id, name, status, status_text, completed,
//                                   progress, point, is_timebox_issue, …}]}]}
// The day mixes two kinds of items, told apart by `is_timebox_issue`:
//   - timebox items: `completed` is a bool, `status` "0" closed / "1" open.
//   - sprint issues: `completed` is null; the calendar still reports them as
//     `status` "0" once closed (on a fully closed day `summary.total_done`
//     equals the sum of every item, sprint ones included).
// So an item is done when `completed` is true or `status` is "0".

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::{mcp_stdio, platform};

/// Rama's /point rule: sprint tasks + timebox add up to this many points a day.
pub const TARGET_POINTS: f64 = 8.0;

/// `uv` may have to sync the environment on a first run, and the server makes
/// one HTTP request per day (plus a token refresh now and then).
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceItem {
    pub name: String,
    pub point: f64,
    pub done: bool,
    /// "sprint" | "timebox".
    pub kind: String,
    /// The server's `status_text` when it has one, else "done" / "open".
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSummary {
    pub date: String,
    pub total_point: f64,
    pub total_done: f64,
    pub items: Vec<SpaceItem>,
    pub warnings: Vec<String>,
}

/// %USERPROFILE%\.claude-kantor\mcp\space-timebox
pub fn default_dir() -> PathBuf {
    platform::home_dir()
        .join(".claude-kantor")
        .join("mcp")
        .join("space-timebox")
}

/// Today's tasks (local date) from the server living in `dir`.
pub async fn fetch_today(dir: &Path) -> Result<SpaceSummary, String> {
    let uv = find_uv().ok_or_else(|| "uv not found. Install it from https://docs.astral.sh/uv/".to_string())?;
    if !dir.is_dir() {
        return Err(format!("space-timebox not found in {}", dir.display()));
    }
    let date = today();
    let args: Vec<String> = vec![
        "--directory".into(),
        dir.to_string_lossy().to_string(),
        "run".into(),
        "space-timebox".into(),
        "serve".into(),
    ];
    let result = mcp_stdio::call_tool(
        &uv,
        &args,
        Some(dir),
        "list_timebox",
        json!({ "start_date": date }),
        FETCH_TIMEOUT,
    )
    .await?;
    summarize(&result, &date)
}

/// The day `date` out of a `list_timebox` result, with the /point warnings.
pub fn summarize(result: &Value, date: &str) -> Result<SpaceSummary, String> {
    let days = result
        .get("days")
        .and_then(Value::as_array)
        .ok_or("Unexpected Space answer: no days.")?;
    let day = days
        .iter()
        .find(|d| d.get("date").and_then(Value::as_str) == Some(date))
        .ok_or_else(|| format!("Space returned no data for {date}."))?;

    let items: Vec<SpaceItem> = day
        .get("items")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter(|i| i.is_object()).map(item).collect())
        .unwrap_or_default();

    // The server's own totals are what Space checks against; the item sums are
    // only a fallback for a day without a summary.
    let summary = day.get("summary").filter(|s| s.is_object());
    let total_point = summary
        .and_then(|s| number(s.get("total_point")))
        .unwrap_or_else(|| items.iter().map(|i| i.point).sum());
    let total_done = summary
        .and_then(|s| number(s.get("total_done")))
        .unwrap_or_else(|| items.iter().filter(|i| i.done).map(|i| i.point).sum());
    let on_leave = summary
        .and_then(|s| s.get("is_cuti"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut warnings = Vec::new();
    // A day with nothing planned (weekend) or a day off has no target to miss.
    if !items.is_empty() && !on_leave && (total_point - TARGET_POINTS).abs() > 1e-6 {
        warnings.push(format!("Total {} pt, target {}", fmt_points(total_point), fmt_points(TARGET_POINTS)));
    }
    let zero_open = items.iter().filter(|i| !i.done && i.point.abs() < 1e-9).count();
    if zero_open > 0 {
        let noun = if zero_open == 1 { "item" } else { "items" };
        warnings.push(format!("{zero_open} open {noun} at 0 pt"));
    }

    Ok(SpaceSummary { date: date.to_string(), total_point, total_done, items, warnings })
}

fn item(raw: &Value) -> SpaceItem {
    let completed = raw.get("completed").and_then(Value::as_bool);
    let status_code = match raw.get("status") {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    let done = completed == Some(true) || status_code == "0";
    // `is_timebox_issue` is in the server's COMPACT_FIELDS. Should it ever be
    // missing, `completed` is the next best tell: only timebox items carry a
    // bool there, sprint issues have null.
    let timebox = raw
        .get("is_timebox_issue")
        .and_then(Value::as_bool)
        .unwrap_or(completed.is_some());
    let status = raw
        .get("status_text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| if done { "done".into() } else { "open".into() });
    SpaceItem {
        name: raw.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string(),
        point: number(raw.get("point")).unwrap_or(0.0),
        done,
        kind: if timebox { "timebox" } else { "sprint" }.into(),
        status,
    }
}

/// Points arrive as numbers or as strings ("1.25", sometimes "1,25").
fn number(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().replace(',', ".").parse().ok(),
        _ => None,
    }
    .filter(|n: &f64| n.is_finite())
}

/// 8 → "8", 7.5 → "7.5", 7.25 → "7.25".
fn fmt_points(p: f64) -> String {
    let s = format!("{:.2}", p);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn today() -> String {
    let t = platform::local_time();
    format!("{:04}-{:02}-{:02}", t.year, t.month, t.day)
}

/// `uv` on PATH, else where its installers put it. Apps started from the Start
/// menu get the user PATH, but not what a terminal profile adds on top.
fn find_uv() -> Option<PathBuf> {
    #[cfg(windows)]
    const NAME: &str = "uv.exe";
    #[cfg(not(windows))]
    const NAME: &str = "uv";

    let on_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    let home = platform::home_dir();
    let fallbacks = [home.join(".local").join("bin"), home.join(".cargo").join("bin")];
    on_path
        .iter()
        .chain(fallbacks.iter())
        .map(|dir| dir.join(NAME))
        .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(date: &str, summary: Value, items: Value) -> Value {
        json!({ "user_auth_id": 1, "days": [{ "date": date, "summary": summary, "items": items }] })
    }

    fn timebox(name: &str, point: Value, status: &str, completed: bool) -> Value {
        json!({ "id": 1, "name": name, "status": status, "status_text": "", "completed": completed,
                "point": point, "is_timebox_issue": true })
    }

    fn sprint(name: &str, point: Value, status: &str) -> Value {
        json!({ "id": 2, "name": name, "status": status, "status_text": "", "completed": null,
                "point": point, "is_timebox_issue": false })
    }

    #[test]
    fn a_balanced_day_has_no_warnings() {
        let r = day(
            "2026-10-05",
            json!({ "total_point": 8, "total_done": 2 }),
            json!([
                timebox("Standup", json!(1), "0", true),
                timebox("Prod test", json!(1), "0", true),
                sprint("Feature", json!(6), "1"),
            ]),
        );
        let s = summarize(&r, "2026-10-05").unwrap();
        assert_eq!(s.date, "2026-10-05");
        assert_eq!((s.total_point, s.total_done), (8.0, 2.0));
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        assert_eq!(
            s.items[0],
            SpaceItem { name: "Standup".into(), point: 1.0, done: true, kind: "timebox".into(), status: "done".into() }
        );
        assert_eq!(
            s.items[2],
            SpaceItem { name: "Feature".into(), point: 6.0, done: false, kind: "sprint".into(), status: "open".into() }
        );
    }

    #[test]
    fn closed_sprint_issue_counts_as_done() {
        let r = day("d", Value::Null, json!([sprint("Fix", json!(0.5), "0")]));
        let s = summarize(&r, "d").unwrap();
        assert!(s.items[0].done);
        assert_eq!(s.items[0].kind, "sprint");
    }

    #[test]
    fn points_parse_from_strings_and_numbers() {
        let r = day(
            "d",
            Value::Null,
            json!([
                sprint("a", json!("1.25"), "1"),
                sprint("b", json!("0,75"), "1"),
                sprint("c", json!(6), "0"),
                sprint("d", json!(null), "0"),
                sprint("e", json!("n/a"), "0"),
            ]),
        );
        let s = summarize(&r, "d").unwrap();
        let points: Vec<f64> = s.items.iter().map(|i| i.point).collect();
        assert_eq!(points, vec![1.25, 0.75, 6.0, 0.0, 0.0]);
        // No summary: totals come from the items.
        assert_eq!(s.total_point, 8.0);
        assert_eq!(s.total_done, 6.0);
    }

    #[test]
    fn summary_totals_may_be_strings() {
        let r = day("d", json!({ "total_point": "7.5", "total_done": "1" }), json!([sprint("a", json!(1), "1")]));
        let s = summarize(&r, "d").unwrap();
        assert_eq!((s.total_point, s.total_done), (7.5, 1.0));
    }

    #[test]
    fn warns_when_total_is_not_eight() {
        let r = day("d", json!({ "total_point": 7.25, "total_done": 0 }), json!([sprint("a", json!(7.25), "1")]));
        assert_eq!(summarize(&r, "d").unwrap().warnings, vec!["Total 7.25 pt, target 8"]);
        let r = day("d", json!({ "total_point": 9, "total_done": 0 }), json!([sprint("a", json!(9), "1")]));
        assert_eq!(summarize(&r, "d").unwrap().warnings, vec!["Total 9 pt, target 8"]);
    }

    #[test]
    fn warns_about_open_items_at_zero() {
        let r = day(
            "d",
            json!({ "total_point": 8, "total_done": 0 }),
            json!([
                sprint("a", json!(8), "1"),
                sprint("b", json!(0), "1"),
                timebox("c", json!("0"), "1", false),
                timebox("done at zero is fine", json!(0), "0", true),
            ]),
        );
        assert_eq!(summarize(&r, "d").unwrap().warnings, vec!["2 open items at 0 pt"]);

        let r = day("d", json!({ "total_point": 7, "total_done": 0 }), json!([sprint("a", json!(7), "1"), sprint("b", json!(0), "1")]));
        assert_eq!(summarize(&r, "d").unwrap().warnings, vec!["Total 7 pt, target 8", "1 open item at 0 pt"]);
    }

    #[test]
    fn empty_day_or_leave_has_no_total_warning() {
        let r = day("d", json!({ "total_point": 0, "total_done": 0 }), json!([]));
        let s = summarize(&r, "d").unwrap();
        assert!(s.items.is_empty() && s.warnings.is_empty());
        let r = day("d", json!({ "total_point": 2, "total_done": 0, "is_cuti": true }), json!([sprint("a", json!(2), "1")]));
        assert!(summarize(&r, "d").unwrap().warnings.is_empty());
    }

    #[test]
    fn kind_is_inferred_when_the_flag_is_missing() {
        let r = day(
            "d",
            Value::Null,
            json!([
                { "name": "tb", "status": "1", "completed": false, "point": 1 },
                { "name": "sp", "status": "1", "completed": null, "point": 1 },
            ]),
        );
        let kinds: Vec<String> = summarize(&r, "d").unwrap().items.into_iter().map(|i| i.kind).collect();
        assert_eq!(kinds, vec!["timebox", "sprint"]);
    }

    #[test]
    fn status_text_and_numeric_status_are_honoured() {
        let r = day(
            "d",
            Value::Null,
            json!([
                { "name": "a", "status": 0, "point": 1, "is_timebox_issue": true },
                { "name": "b", "status": "1", "status_text": "In Progress", "point": 1, "is_timebox_issue": false },
            ]),
        );
        let s = summarize(&r, "d").unwrap();
        assert!(s.items[0].done);
        assert_eq!(s.items[1].status, "In Progress");
        assert!(!s.items[1].done);
    }

    #[test]
    fn picks_the_requested_day_and_rejects_bad_shapes() {
        let r = json!({ "days": [
            { "date": "2026-10-04", "summary": { "total_point": 3, "total_done": 0 }, "items": [] },
            { "date": "2026-10-05", "summary": { "total_point": 8, "total_done": 8 }, "items": [] },
        ]});
        assert_eq!(summarize(&r, "2026-10-05").unwrap().total_done, 8.0);
        assert_eq!(summarize(&r, "2026-10-06").unwrap_err(), "Space returned no data for 2026-10-06.");
        assert!(summarize(&json!({}), "d").is_err());
        assert!(summarize(&json!({ "days": "x" }), "d").is_err());
    }

    #[test]
    fn serializes_camel_case() {
        let r = day("d", json!({ "total_point": 8, "total_done": 0 }), json!([sprint("a", json!(8), "1")]));
        let v = serde_json::to_value(summarize(&r, "d").unwrap()).unwrap();
        assert!(v.get("totalPoint").is_some() && v.get("totalDone").is_some());
    }

    #[test]
    fn default_dir_is_under_claude_kantor() {
        let d = default_dir();
        assert!(d.ends_with(Path::new(".claude-kantor").join("mcp").join("space-timebox")));
    }

    #[test]
    fn today_is_iso() {
        let t = today();
        assert_eq!(t.len(), 10);
        assert_eq!(&t[4..5], "-");
        assert_eq!(&t[7..8], "-");
    }

    /// Live eval against the real server and the signed-in Space account.
    /// Prints counts and totals only, never task names. Run with:
    /// `cargo test -p coucou --lib space_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn space_live() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let started = std::time::Instant::now();
        let s = rt.block_on(fetch_today(&default_dir())).expect("fetch_today");
        let open = s.items.iter().filter(|i| !i.done).count();
        let sprint = s.items.iter().filter(|i| i.kind == "sprint").count();
        println!(
            "date {} | items {} (sprint {}, timebox {}, open {}) | total {} pt, done {} pt | warnings {:?} | {} ms",
            s.date,
            s.items.len(),
            sprint,
            s.items.len() - sprint,
            open,
            s.total_point,
            s.total_done,
            s.warnings,
            started.elapsed().as_millis()
        );
        assert_eq!(s.date, today());
    }
}
