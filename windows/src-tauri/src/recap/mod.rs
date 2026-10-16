// Weekly recap history — port of RecapStore.swift.
//
// Every hook event the relay forwards also passes through here. A "turn" runs
// from a prompt (or the first tool call) to Stop, and only its counts and two
// names are kept: the agent's pill ID and the project folder's last path
// component. Never a command, a file path, file contents or a prompt.
//
// The history lives in recap.json under platform::local_dir()
// (%LOCALAPPDATA%\Coucou on Windows, ~/.local/share/coucou on Linux), keeps a
// 12-week rolling window and a hard cap on its length, and is written whole to
// a temporary file then renamed over the old one, so a crash never leaves half
// a file. Nothing in it ever leaves the machine.
//
// Aggregation (weeks, top agent, busiest day…) happens in the island
// (src/recap/summary.ts): it needs the user's time zone, which JavaScript has
// and plain Rust does not.
//
// Ported from upstream (Louis-CFM/coucou 8d47969), split here by job:
// payload.rs reads a hook payload, image.rs saves the shared PNG, and
// recap.json is read and written through prefs_file.rs (corrupt copies set
// aside, atomic saves), like settings.json.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::island::WINDOW_LABEL;
use crate::platform;

mod image;
mod payload;
#[cfg(test)]
mod tests;

use image::save_png;
use payload::{agent_id, file_change, is_week_key, project_name, session_key, text};

/// 12 weeks, like the Mac.
pub const WINDOW_SECS: i64 = 12 * 7 * 86_400;
/// A turn with no event for two hours is closed at its last event (agent
/// crashed, or never sent Stop) — RecapStore.pruneStale.
const STALE_SECS: i64 = 2 * 3600;
/// Hard caps, whatever the window holds: about 2 MB of JSON at most.
const MAX_TURNS: usize = 10_000;
const MAX_DECISIONS: usize = 10_000;
const MAX_DRAFTS: usize = 256;
const MAX_REQUESTS: usize = 64;
/// A recap.json larger than this was not written by us: start over.
const MAX_FILE_BYTES: u64 = 16 << 20;

/// Tool names that run a shell command, across the agents the relay serves.
const COMMAND_TOOLS: &[&str] = &[
    "Bash",
    "PowerShell",
    "Execute",
    "mcp__ide__executeCode",
    "run_shell_command",
    "shell",
    "local_shell",
    "exec_command",
];

// ── Persisted model ───────────────────────────────────────────────────────────

/// One finished turn. Times are Unix seconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub agent: String,
    pub project: String,
    pub start: i64,
    pub end: i64,
    pub files_changed: u32,
    pub lines_added: u32,
    pub lines_removed: u32,
    pub commands_run: u32,
    pub questions: u32,
}

/// A click on Allow or Deny in the island.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub agent: String,
    pub date: i64,
    /// "allow" or "deny".
    pub decision: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// "Keep a history of my coding sessions" — on by default, like the Mac.
    pub enabled: bool,
    /// Leave the project name out of the shared image.
    pub hide_projects: bool,
    /// Monday (YYYY-MM-DD) of the week the recap was last shown on its own.
    pub last_shown_week: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { enabled: true, hide_projects: false, last_shown_week: String::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct History {
    schema_version: u32,
    turns: Vec<Turn>,
    decisions: Vec<Decision>,
    prefs: Prefs,
}

impl Default for History {
    fn default() -> Self {
        Self { schema_version: 1, turns: Vec::new(), decisions: Vec::new(), prefs: Prefs::default() }
    }
}

/// What the island reads: the part of the history it asked for.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryView {
    pub turns: Vec<Turn>,
    pub decisions: Vec<Decision>,
    pub prefs: Prefs,
}

/// A turn in progress, in memory only. The paths are only there to count
/// distinct files and are never written anywhere.
#[derive(Debug)]
struct Draft {
    agent: String,
    project: String,
    start: i64,
    last_event: i64,
    paths: HashSet<String>,
    lines_added: u32,
    lines_removed: u32,
    commands_run: u32,
    questions: u32,
}

impl Draft {
    fn into_turn(self, end: i64) -> Turn {
        Turn {
            agent: self.agent,
            project: self.project,
            start: self.start,
            end: end.max(self.start),
            files_changed: self.paths.len().min(u32::MAX as usize) as u32,
            lines_added: self.lines_added,
            lines_removed: self.lines_removed,
            commands_run: self.commands_run,
            questions: self.questions,
        }
    }
}

// ── Store ─────────────────────────────────────────────────────────────────────

pub struct Recap {
    path: PathBuf,
    history: History,
    drafts: HashMap<String, Draft>,
    /// Permission request ID → agent, until the island answers it.
    requests: HashMap<String, String>,
    /// The last image saved, so "Show in folder" never takes a path from the page.
    last_saved: Option<PathBuf>,
}

impl Recap {
    /// Reads `path`. A file that cannot be used is renamed aside, never lost.
    pub fn load(path: PathBuf, now: i64) -> Self {
        let history = read_history(&path);
        let mut recap = Self {
            path,
            history,
            drafts: HashMap::new(),
            requests: HashMap::new(),
            last_saved: None,
        };
        recap.prune(now);
        recap
    }

    /// One hook event, as the relay delivered it.
    pub fn observe(&mut self, payload: &Value, now: i64) {
        if !self.history.prefs.enabled {
            return;
        }
        self.close_stale(now);
        let event = text(payload, "hook_event_name");
        let agent = agent_id(payload);
        let key = session_key(payload, &agent);

        match event {
            "UserPromptSubmit" => {
                self.draft(&key, &agent, payload, now);
            }
            "PreToolUse" => {
                let tool = text(payload, "tool_name");
                let draft = self.draft(&key, &agent, payload, now);
                if COMMAND_TOOLS.contains(&tool) {
                    draft.commands_run = draft.commands_run.saturating_add(1);
                }
                if tool == "AskUserQuestion" {
                    draft.questions = draft.questions.saturating_add(1);
                }
            }
            "PostToolUse" => {
                let tool = text(payload, "tool_name");
                let input = payload.get("tool_input").unwrap_or(&Value::Null);
                let change = file_change(tool, input);
                let draft = self.draft(&key, &agent, payload, now);
                if let Some((path, added, removed)) = change {
                    draft.paths.insert(path);
                    draft.lines_added = draft.lines_added.saturating_add(added);
                    draft.lines_removed = draft.lines_removed.saturating_add(removed);
                }
            }
            // Unlike the Mac, SessionEnd closes the turn instead of dropping it:
            // a session quit mid-turn still worked.
            "Stop" | "StopFailure" | "Interrupt" | "SessionEnd" => {
                if let Some(draft) = self.drafts.remove(&key) {
                    self.history.turns.push(draft.into_turn(now));
                    self.prune(now);
                    self.save();
                }
            }
            _ => {}
        }
    }

    /// The draft for `key`, created on the first event of a turn.
    fn draft(&mut self, key: &str, agent: &str, payload: &Value, now: i64) -> &mut Draft {
        if !self.drafts.contains_key(key) && self.drafts.len() >= MAX_DRAFTS {
            self.close_oldest_draft();
        }
        let draft = self.drafts.entry(key.to_string()).or_insert_with(|| Draft {
            agent: agent.to_string(),
            project: project_name(text(payload, "cwd")),
            start: now,
            last_event: now,
            paths: HashSet::new(),
            lines_added: 0,
            lines_removed: 0,
            commands_run: 0,
            questions: 0,
        });
        draft.last_event = now;
        draft
    }

    fn close_oldest_draft(&mut self) {
        let Some(key) = self
            .drafts
            .iter()
            .min_by_key(|(_, d)| d.last_event)
            .map(|(k, _)| k.clone())
        else {
            return;
        };
        if let Some(draft) = self.drafts.remove(&key) {
            let end = draft.last_event;
            self.history.turns.push(draft.into_turn(end));
        }
    }

    /// RecapStore.pruneStale: turns silent for two hours count up to their
    /// last event instead of being lost.
    fn close_stale(&mut self, now: i64) {
        let stale: Vec<String> = self
            .drafts
            .iter()
            .filter(|(_, d)| d.last_event < now - STALE_SECS)
            .map(|(k, _)| k.clone())
            .collect();
        if stale.is_empty() {
            return;
        }
        for key in stale {
            if let Some(draft) = self.drafts.remove(&key) {
                let end = draft.last_event;
                self.history.turns.push(draft.into_turn(end));
            }
        }
        self.prune(now);
        self.save();
    }

    /// A permission request reached the island: remember whose it is.
    pub fn note_request(&mut self, request_id: &str, payload: &Value) {
        if self.requests.len() >= MAX_REQUESTS {
            self.requests.clear();
        }
        self.requests.insert(request_id.to_string(), agent_id(payload));
    }

    /// The request was handed back to the terminal: nothing to record.
    pub fn forget_request(&mut self, request_id: &str) {
        self.requests.remove(request_id);
    }

    /// A click on Allow or Deny.
    pub fn record_decision(&mut self, request_id: &str, decision: &str, now: i64) {
        let agent = self
            .requests
            .remove(request_id)
            .unwrap_or_else(|| "integration_claude".to_string());
        if !self.history.prefs.enabled {
            return;
        }
        let word = match decision {
            "allow" | "always" => "allow",
            "deny" => "deny",
            _ => return,
        };
        self.history.decisions.push(Decision { agent, date: now, decision: word.to_string() });
        self.prune(now);
        self.save();
    }

    /// Everything from `since` on (Unix seconds).
    pub fn view(&self, since: i64) -> HistoryView {
        HistoryView {
            turns: self.history.turns.iter().filter(|t| t.start >= since).cloned().collect(),
            decisions: self.history.decisions.iter().filter(|d| d.date >= since).cloned().collect(),
            prefs: self.history.prefs.clone(),
        }
    }

    pub fn prefs(&self) -> &Prefs {
        &self.history.prefs
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.history.prefs.enabled = enabled;
        if !enabled {
            self.drafts.clear();
            self.requests.clear();
        }
        self.save();
    }

    pub fn set_hide_projects(&mut self, hide: bool) {
        self.history.prefs.hide_projects = hide;
        self.save();
    }

    /// `week` is the Monday the recap was shown for, as YYYY-MM-DD.
    pub fn mark_shown(&mut self, week: &str) {
        if !is_week_key(week) {
            return;
        }
        self.history.prefs.last_shown_week = week.to_string();
        self.save();
    }

    /// Settings → General → Clear history. The preferences stay.
    pub fn clear(&mut self) {
        self.history.turns.clear();
        self.history.decisions.clear();
        self.drafts.clear();
        self.save();
    }

    /// 12-week window, then the hard caps (oldest first out).
    fn prune(&mut self, now: i64) {
        let cutoff = now - WINDOW_SECS;
        self.history.turns.retain(|t| t.start >= cutoff);
        self.history.decisions.retain(|d| d.date >= cutoff);
        if self.history.turns.len() > MAX_TURNS {
            self.history.turns.sort_by_key(|t| t.start);
            let excess = self.history.turns.len() - MAX_TURNS;
            self.history.turns.drain(..excess);
        }
        if self.history.decisions.len() > MAX_DECISIONS {
            self.history.decisions.sort_by_key(|d| d.date);
            let excess = self.history.decisions.len() - MAX_DECISIONS;
            self.history.decisions.drain(..excess);
        }
    }

    fn save(&self) {
        if let Err(err) = write_history(&self.path, &self.history) {
            note(format!("could not save the weekly recap history: {err}"));
        }
    }
}

// ── Reading and writing recap.json ────────────────────────────────────────────

/// The history in `path`; a file too big to be ours, or one that cannot be used,
/// gives an empty history (prefs_file.rs keeps a copy of what was there).
fn read_history(path: &Path) -> History {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_FILE_BYTES) {
        note(format!("{} is too big to be a recap history, starting over", path.display()));
        return History::default();
    }
    crate::prefs_file::load_from(path)
}

/// Whole file to a temporary sibling, flushed, then renamed over the old one.
fn write_history(path: &Path, history: &History) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        platform::ensure_private_dir(dir)?;
    }
    crate::prefs_file::save_to(path, history)
}

/// One line in coucou.log. Tests must never write to the real one.
fn note(message: String) {
    #[cfg(not(test))]
    crate::log::line(message);
    #[cfg(test)]
    eprintln!("{message}");
}

// ── Tauri glue ────────────────────────────────────────────────────────────────

pub struct Store(Mutex<Recap>);

impl Store {
    fn lock(&self) -> MutexGuard<'_, Recap> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn load() -> Store {
    Store(Mutex::new(Recap::load(platform::local_dir().join("recap.json"), now())))
}

/// Called by the relay server for every hook event. An agent starting work is
/// also one of the moments the Monday recap may show up.
pub fn observe(app: &AppHandle, payload: &Value) {
    if let Some(store) = app.try_state::<Store>() {
        store.lock().observe(payload, now());
    }
    if matches!(text(payload, "hook_event_name"), "SessionStart" | "UserPromptSubmit") {
        let _ = app.emit_to(WINDOW_LABEL, "recap-check", ());
    }
}

pub fn note_request(app: &AppHandle, request_id: &str, payload: &Value) {
    if let Some(store) = app.try_state::<Store>() {
        store.lock().note_request(request_id, payload);
    }
}

pub fn forget_request(app: &AppHandle, request_id: &str) {
    if let Some(store) = app.try_state::<Store>() {
        store.lock().forget_request(request_id);
    }
}

pub fn record_decision(app: &AppHandle, request_id: &str, decision: &str) {
    if let Some(store) = app.try_state::<Store>() {
        store.lock().record_decision(request_id, decision, now());
    }
}

#[tauri::command]
pub fn recap_history(store: State<Store>, since: i64) -> HistoryView {
    store.lock().view(since)
}

#[tauri::command]
pub fn recap_prefs(store: State<Store>) -> Prefs {
    store.lock().prefs().clone()
}

#[tauri::command]
pub fn recap_set_enabled(store: State<Store>, enabled: bool) {
    store.lock().set_enabled(enabled);
}

#[tauri::command]
pub fn recap_set_hide_projects(store: State<Store>, hide: bool) {
    store.lock().set_hide_projects(hide);
}

#[tauri::command]
pub fn recap_mark_shown(store: State<Store>, week: String) {
    store.lock().mark_shown(&week);
}

#[tauri::command]
pub fn recap_clear(store: State<Store>) {
    store.lock().clear();
}

/// `data` is the canvas's PNG as a data URL. Returns where it was written.
#[tauri::command]
pub fn recap_save_png(store: State<Store>, data: String, week: String) -> Result<String, String> {
    let path = save_png(&platform::picture_dirs(), &data, &week)?;
    let shown = path.to_string_lossy().to_string();
    store.lock().last_saved = Some(path);
    Ok(shown)
}

/// Opens the folder of the image saved last — never a path from the page.
#[tauri::command]
pub fn recap_reveal_saved(store: State<Store>) {
    let dir = store.lock().last_saved.as_ref().and_then(|p| p.parent().map(Path::to_path_buf));
    if let Some(dir) = dir {
        platform::reveal_folder(&dir.to_string_lossy());
    }
}
