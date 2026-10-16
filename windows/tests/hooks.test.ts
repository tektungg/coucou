// The return to idle that Stop arms (src/island/hooks.ts), through the stand-in
// Tauri with fake timers: a finished turn goes idle after 5.2 s, unless the
// session has already moved on. Adapted from upstream's tests/hooks.test.mjs
// (3491a2b) to this build's handler table. Run with `npm test`.
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS helper, no types
import { emit } from "./tauri.mjs";
import { registerHookHandlers } from "../src/island/hooks.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

const SESSION_ID = "0b6f6d0e-1111-2222-3333-444455556666";
const PILL = "cc_0b6f6d0e";
/** FINISHED_MS in hooks.ts, and a moment before it. */
const FINISHED_MS = 5200;
const SOON_MS = 1000;

const island = {
  alert() {}, setView() {}, reveal() {}, dropPin() {}, focusForCard() {}, returnFocusAfterCard() {},
};
// @ts-expect-error a stand-in with only what the handlers call
registerHookHandlers(island);

const hook = (payload: Record<string, unknown>) =>
  emit("hook", { session_id: SESSION_ID, cwd: "/p/proj", ...payload });
const pill = (id = PILL) => State.tasks.find((t) => t.id === id);
const stop = (extra: Record<string, unknown> = {}) =>
  hook({ hook_event_name: "Stop", last_assistant_message: "Done.", ...extra });

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
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

test("a finished turn shows as done, then goes idle after 5.2 s", () => {
  hook({ hook_event_name: "UserPromptSubmit", prompt: "fix it" });
  stop();
  assert.equal(pill()?.state, "finished");
  mock.timers.tick(FINISHED_MS - 1);
  assert.equal(pill()?.state, "finished");
  mock.timers.tick(1);
  assert.equal(pill()?.state, "idle");
  assert.equal(pill()?.pillBadge ?? null, null);
});

test("a new prompt right after Stop is not knocked back to idle", () => {
  stop();
  mock.timers.tick(SOON_MS);
  hook({ hook_event_name: "UserPromptSubmit", prompt: "and the tests" });
  assert.equal(pill()?.pillBadge ?? null, null, "the done badge goes with the new turn");
  mock.timers.tick(FINISHED_MS);
  assert.equal(pill()?.state, "thinking");
});

test("a tool call or its result right after Stop keeps the pill working", () => {
  for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
    stop();
    mock.timers.tick(SOON_MS);
    hook({ hook_event_name: event, tool_name: "Bash", tool_input: { command: "ls" } });
    mock.timers.tick(FINISHED_MS);
    assert.equal(pill()?.state, "working", event);
  }
});

test("a question or a rate limit right after Stop stays", () => {
  stop();
  hook({ hook_event_name: "Notification", message: "Which file should I edit?" });
  mock.timers.tick(FINISHED_MS);
  assert.equal(pill()?.state, "question");

  stop();
  hook({ hook_event_name: "Notification", message: "Claude hit the rate limit" });
  mock.timers.tick(FINISHED_MS);
  assert.equal(pill()?.state, "ratelimit");
});

test("an unrelated notification does not cancel the return to idle", () => {
  stop();
  hook({ hook_event_name: "Notification", message: "Claude is waiting for your input" });
  mock.timers.tick(FINISHED_MS);
  assert.equal(pill()?.state, "idle");
});

test("a failure right after Stop shows as an error, not idle", () => {
  stop();
  hook({ hook_event_name: "StopFailure" });
  mock.timers.tick(FINISHED_MS);
  assert.equal(pill()?.state, "error");
});

test("two Stops in a row arm one timer, counted from the last", () => {
  stop();
  mock.timers.tick(FINISHED_MS - SOON_MS);
  hook({ hook_event_name: "UserPromptSubmit", prompt: "again" });
  stop();
  mock.timers.tick(SOON_MS);
  assert.equal(pill()?.state, "finished", "the first Stop's timer is gone");
  mock.timers.tick(FINISHED_MS - SOON_MS);
  assert.equal(pill()?.state, "idle");
});

test("an external agent's pill goes away after its Stop, not in the middle of its next turn", () => {
  const agent = "agent_gemini";
  const tagged = (payload: Record<string, unknown>) => hook({ coucou_agent: "gemini", ...payload });
  tagged({ hook_event_name: "UserPromptSubmit", prompt: "hi" });
  tagged({ hook_event_name: "Stop" });
  mock.timers.tick(SOON_MS);
  tagged({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/p/a.ts" } });
  mock.timers.tick(FINISHED_MS);
  assert.equal(pill(agent)?.state, "working", "still there, still working");
  tagged({ hook_event_name: "Stop" });
  mock.timers.tick(FINISHED_MS);
  assert.equal(pill(agent), undefined);
});
