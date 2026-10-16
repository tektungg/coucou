// Live diff and the finished line, end to end through the hook handler (via the
// stand-in Tauri): file edits become diff steps with their diff stored (and
// bounded), and Stop leaves Claude's final message until the next turn.
// Adapted from upstream's tests/livediff.test.mjs (122e130). Run with `npm test`.
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS helper, no types
import { emit } from "./tauri.mjs";
import { registerHookHandlers } from "../src/island/hooks.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { DIFF_TTL_MS, MAX_DIFFS_PER_PILL, sessionDiffs } from "../src/core/sessionDiffs.ts";
import { parseDiffStep } from "../src/core/diff.ts";

const CLAUDE = "integration_claude";
const SESSION = "cc_0b6f6d0e";

const island = {
  alert() {}, setView() {}, reveal() {}, dropPin() {}, focusForCard() {}, returnFocusAfterCard() {},
};
// @ts-expect-error a stand-in with only what the handlers call
registerHookHandlers(island);

const hook = (payload: Record<string, unknown>) => emit("hook", payload);
const task = (id = CLAUDE) => State.tasks.find((t) => t.id === id);
const lastStep = (id = CLAUDE) => task(id)?.steps.at(-1) ?? "";

const edit = (extra: Record<string, unknown> = {}) =>
  hook({
    hook_event_name: "PostToolUse",
    cwd: "/p/proj",
    tool_name: "Edit",
    tool_input: { file_path: "/p/proj/src/app.ts", old_string: "a\nb\n", new_string: "a\nc\nd\n" },
    ...extra,
  });

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  for (const t of State.tasks) sessionDiffs.clear(t.id);
  State.tasks = [];
  State.focusId = null;
  State.mode = "hidden";
  State.view = "overview";
  State.paused = false;
  State.isPinned = false;
  State.pendingApproval = null;
  State.pendingQuestion = null;
  State.settings = { ...DEFAULT_SETTINGS };
  State.loadIntegrationTasks();
});

afterEach(() => {
  mock.timers.runAll();
  mock.timers.reset();
});

// ── Live diff ─────────────────────────────────────────────────────────────────

test("a finished Edit adds a diff step with its counts, and keeps the diff", () => {
  edit();
  const step = parseDiffStep(lastStep());
  assert.ok(step);
  assert.deepEqual([step.filename, step.added, step.removed], ["app.ts", 2, 1]);
  const diff = sessionDiffs.find(CLAUDE, step.diffId);
  assert.equal(diff?.path, "/p/proj/src/app.ts");
  assert.ok((diff?.hunks.length ?? 0) > 0);
});

test("Write and MultiEdit are diffed too; other tools and PreToolUse are not", () => {
  hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "C:\\p\\new.md", content: "x\ny\n" } });
  assert.equal(parseDiffStep(lastStep())?.filename, "new.md");
  hook({
    hook_event_name: "PostToolUse",
    tool_name: "MultiEdit",
    tool_input: { file_path: "/p/m.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] },
  });
  const multi = parseDiffStep(lastStep());
  assert.deepEqual([multi?.added, multi?.removed], [2, 2]);

  const before = task()?.steps.length ?? 0;
  hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } });
  assert.equal(task()?.steps.length, before + 1, "only the PreToolUse label");
  assert.equal(parseDiffStep(lastStep()), null);
  assert.equal(sessionDiffs.count(CLAUDE), 2);
});

test("Ctrl+E opens the latest edit: the last one kept for the pill", () => {
  assert.equal(sessionDiffs.latest(CLAUDE), null, "none yet");
  hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/p/one.md", content: "a" } });
  hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/p/two.md", content: "b" } });
  assert.equal(sessionDiffs.latest(CLAUDE)?.path, "/p/two.md");
  assert.equal(sessionDiffs.latest("integration_other"), null);
});

test("an edit with no change, or one the relay had to cut, adds no diff", () => {
  hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/p/a.ts", old_string: "same", new_string: "same" } });
  edit({ coucou_diff_truncated: true });
  assert.equal(sessionDiffs.count(CLAUDE), 0);
  assert.equal(task()?.steps.length, 0);
});

test("a session pill keeps its own diffs, and SessionEnd drops them", () => {
  edit({ session_id: "0b6f6d0e" });
  assert.equal(sessionDiffs.count(SESSION), 1);
  assert.equal(sessionDiffs.count(CLAUDE), 0);
  hook({ hook_event_name: "SessionEnd", session_id: "0b6f6d0e", cwd: "/p/proj" });
  assert.equal(sessionDiffs.count(SESSION), 0);
});

test("diffs are bounded per pill and forgotten an hour after the last one", () => {
  for (let i = 0; i < MAX_DIFFS_PER_PILL + 5; i++) edit();
  assert.equal(sessionDiffs.count(CLAUDE), MAX_DIFFS_PER_PILL);
  mock.timers.tick(DIFF_TTL_MS + 1);
  assert.equal(sessionDiffs.count(CLAUDE), 0);
});

// ── The finished line ─────────────────────────────────────────────────────────

test("Stop keeps Claude's final message, as one line, until the next turn", () => {
  hook({ hook_event_name: "UserPromptSubmit", prompt: "fix it" });
  hook({ hook_event_name: "Stop", last_assistant_message: "## Done\n\nFixed **two** bugs in `app.ts`.\n\nMore below." });
  assert.equal(task()?.finalLine, "Done");
  assert.equal(lastStep(), "Done");
  hook({ hook_event_name: "UserPromptSubmit", prompt: "and now?" });
  assert.equal(task()?.finalLine, null);
});

test("Stop without a final message falls back to its message, or nothing", () => {
  hook({ hook_event_name: "Stop", message: "All set." });
  assert.equal(task()?.finalLine, "All set.");
  hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/p/a.ts" } });
  assert.equal(task()?.finalLine, null);
  hook({ hook_event_name: "Stop" });
  assert.equal(task()?.finalLine, null);
});
