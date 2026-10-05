// Per-session pills: ids, colours, ordering and sweeping. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_COLORS, SESSION_IDLE_SWEEP_MS, compareSessions, isSessionPill, resolvesCard, routeHook,
  sessionColor, sessionPillId, staleSessions,
} from "../src/island/sessions.ts";

test("a card closes when its session carries on past it, not for a parallel tool", () => {
  // The tool the card asked about ran: it was answered in the terminal.
  assert.ok(resolvesCard("PostToolUse", "ExitPlanMode", "ExitPlanMode"));
  assert.ok(resolvesCard("PostToolUseFailure", "AskUserQuestion", "AskUserQuestion"));
  // The turn moved on or ended.
  for (const e of ["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"]) {
    assert.ok(resolvesCard(e, undefined, "Bash"), e);
  }
  // Another tool finishing in parallel, or the request itself, proves nothing.
  assert.ok(!resolvesCard("PostToolUse", "Read", "Bash"));
  assert.ok(!resolvesCard("PreToolUse", "Bash", "Bash"));
  assert.ok(!resolvesCard("PermissionRequest", "Bash", "Bash"));
  assert.ok(!resolvesCard("Notification", undefined, "Bash"));
});

test("hook events route to the agent, else the session, else the catch-all pill", () => {
  assert.equal(routeHook("codex", "2515f9f8-aaaa"), "agent_codex");
  assert.equal(routeHook(null, "2515f9f8-78bd-497e"), "cc_2515f9f8");
  assert.equal(routeHook(null, ""), "integration_claude");
  assert.equal(routeHook(null, "   "), "integration_claude");
});

test("a session id becomes a short, stable pill id", () => {
  const id = "2515f9f8-78bd-497e-9a11-6e5d79741d11";
  assert.equal(sessionPillId(id), "cc_2515f9f8");
  assert.equal(sessionPillId(id.toUpperCase()), "cc_2515f9f8");
  assert.ok(isSessionPill(sessionPillId(id)));
  assert.ok(!isSessionPill("integration_claude"));
});

test("an id that is not a UUID still gets a stable, safe pill id", () => {
  const a = sessionPillId("weird id!");
  assert.match(a, /^cc_[0-9a-f]{8}$/);
  assert.equal(a, sessionPillId("weird id!"));
  assert.notEqual(a, sessionPillId("other"));
});

test("colours go to the first free palette slot, then repeat stably", () => {
  assert.equal(sessionColor("s1", []), SESSION_COLORS[0]);
  assert.equal(sessionColor("s2", [SESSION_COLORS[0]]), SESSION_COLORS[1]);
  const full = sessionColor("s9", [...SESSION_COLORS]);
  assert.ok(SESSION_COLORS.includes(full));
  assert.equal(full, sessionColor("s9", [...SESSION_COLORS]));
});

test("the most recently active session comes first", () => {
  const list = [
    { id: "cc_a", color: "", lastEventAt: 10 },
    { id: "cc_b", color: "", lastEventAt: 30 },
    { id: "cc_c", color: "", lastEventAt: 20 },
  ].sort(compareSessions);
  assert.deepEqual(list.map((t) => t.id), ["cc_b", "cc_c", "cc_a"]);
});

test("quiet sessions are swept, but never one waiting on a human or in focus", () => {
  const now = 10 * SESSION_IDLE_SWEEP_MS;
  const old = now - SESSION_IDLE_SWEEP_MS - 1;
  const tasks = [
    { id: "cc_old", color: "", lastEventAt: old, state: "idle" },
    { id: "cc_fresh", color: "", lastEventAt: now - 1000, state: "idle" },
    { id: "cc_waiting", color: "", lastEventAt: old, state: "approval" },
    { id: "cc_asking", color: "", lastEventAt: old, state: "question" },
    { id: "cc_focus", color: "", lastEventAt: old, state: "idle" },
    { id: "integration_quota", color: "", lastEventAt: 0, state: "idle" },
  ];
  assert.deepEqual(staleSessions(tasks, now, "cc_focus"), ["cc_old"]);
});
