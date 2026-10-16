// The desktop Mochi, island side (src/island/desktop.ts), through the Tauri
// stand-in: what the island tells his window, and which alerts bring him home.
// The pure life cycle is tested in tests/desktop.test.ts, the window itself in
// src-tauri/src/desktop/. Run with `npm test`.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS helper, no types
import { answer, emit, resetCalls, sent } from "./tauri.mjs";
// @ts-expect-error plain JS helper, no types
import { installFakeDom } from "./fakedom.mjs";
import { DEFAULT_SETTINGS, INTEGRATION_AGENTS, State } from "../src/core/state.ts";
import { DESKTOP_EVENTS } from "../src/mochi/desktopLogic.ts";

// island/desktop.ts reaches views that build a node when they load.
installFakeDom();
const { DesktopLink } = await import("../src/island/desktop.ts");

const MESSAGES = "integration_messages";
const host = { reveal() {}, wardrobeFromDesktop() {}, dizzyFromDesktop() {} };

/** What the island sent the desktop window, oldest first. */
function snapshots() {
  return sent("plugin:event|emit_to")
    .filter((a) => a.event === DESKTOP_EVENTS.state)
    .map((a) => a.payload);
}

async function link(mode = "poll") {
  answer("desktop_mochi_info", { mode, onDesktop: false });
  const l = new DesktopLink(host);
  await l.init();
  return l;
}

function messagesTask() {
  const t = { ...INTEGRATION_AGENTS.find((a) => a.id === MESSAGES) };
  State.tasks = [t];
  State.setFocus(MESSAGES);
  return t;
}

beforeEach(() => {
  resetCalls();
  // Each test's link subscribes to State: drop the previous tests' links.
  State.listeners.clear();
  State.settings = { ...DEFAULT_SETTINGS };
  State.tasks = [];
  State.focusId = null;
  State.pendingApproval = null;
  State.pendingQuestion = null;
  State.paused = false;
  State.mochiOnDesktop = false;
});

test("the snapshot carries the focused pill's act, as its age, and the pill's colour", async () => {
  const t = messagesTask();
  t.act = { name: "mail", variant: null, at: performance.now() - 200 };
  await link();
  const snap = snapshots().at(-1);
  assert.equal(snap.acts.oneShot.name, "mail");
  assert.ok(snap.acts.oneShot.ageMs >= 200 && snap.acts.oneShot.ageMs < 2000, "an age, not a timestamp");
  assert.equal(snap.bodyColor, t.color);
});

test("a one-shot growing older sends nothing new; a new one does", async () => {
  const t = messagesTask();
  t.act = { name: "mail", variant: null, at: performance.now() };
  await link();
  const before = snapshots().length;
  State.notify();
  assert.equal(snapshots().length, before, "same act, same snapshot");
  t.act = { name: "mail", variant: null, at: performance.now() + 1 };
  State.notify();
  assert.equal(snapshots().length, before + 1);
});

test("an agent session's pill: his own colour", async () => {
  State.tasks = [{ ...INTEGRATION_AGENTS[0], id: "cc_1", isIntegration: false }];
  await link();
  assert.equal(snapshots().at(-1).bodyColor, null);
  assert.equal(snapshots().at(-1).acts.oneShot, null);
});

test("his window (re)loading gets the snapshot again", async () => {
  messagesTask();
  await link();
  const before = snapshots().length;
  emit(DESKTOP_EVENTS.ready, null);
  assert.equal(snapshots().length, before + 1);
});

test("a question card waiting for its answers sends him back to the island", async () => {
  const l = await link();
  l.controller.installed();
  assert.equal(l.controller.phase, "onDesktop");
  State.pendingQuestion = { requestId: "q", taskId: "cc_1", items: [] };
  State.notify();
  assert.equal(l.controller.phase, "retracting");
});

test("an integration's alert: he looks up and stays on his spot", async () => {
  const l = await link();
  l.controller.installed();
  resetCalls();
  l.notice();
  const emotes = sent("plugin:event|emit_to").filter((a) => a.event === DESKTOP_EVENTS.emote);
  assert.equal(emotes.length, 1);
  assert.equal(emotes[0].payload.emote, "surprised");
  assert.equal(l.controller.phase, "onDesktop");
});

test("where windows can't be placed he stays in the island", async () => {
  const l = await link("off");
  assert.equal(l.supported, false);
  assert.equal(l.canPickUp(), false);
  assert.deepEqual(snapshots(), [], "nothing listens on that side");
});
