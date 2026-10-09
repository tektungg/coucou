// Overview carousel stepping and gestures. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRAG_DISTANCE, GESTURE_GAP_MS, SESSIONS_CHIP_ID, SESSION_STOP_PREFIX, SWIPE_COOLDOWN_MS, SwipeAccumulator,
  dragDirection, pillStops, sessionChips, slideDirection, stepFocus,
} from "../src/views/carousel.ts";
import { SESSION_PREFIX } from "../src/island/sessions.ts";

const ids = ["cc_a", "integration_quota", "integration_space"];

test("stepping wraps round both ends", () => {
  assert.equal(stepFocus(ids, "cc_a", 1), "integration_quota");
  assert.equal(stepFocus(ids, "integration_space", 1), "cc_a");
  assert.equal(stepFocus(ids, "cc_a", -1), "integration_space");
  assert.equal(stepFocus(ids, "gone", 1), "cc_a");
  assert.equal(stepFocus([], "cc_a", 1), null);
  assert.equal(stepFocus(["only"], "only", 1), "only");
});

test("the slide follows the order of the dots", () => {
  assert.equal(slideDirection(ids, "cc_a", "integration_space"), 1);
  assert.equal(slideDirection(ids, "integration_space", "cc_a"), -1);
  assert.equal(slideDirection(ids, "cc_a", "cc_a"), 0);
  assert.equal(slideDirection(ids, null, "cc_a"), 0);
});

test("a trackpad flick is one swipe, its momentum is swallowed", () => {
  const s = new SwipeAccumulator();
  let t = 0;
  const fired: number[] = [];
  // 30 small deltas of 8 px, 10 ms apart: one gesture of 240 px.
  for (let i = 0; i < 30; i++) {
    const d = s.add(8, 0, (t += 10));
    if (d !== 0) fired.push(d);
  }
  assert.deepEqual(fired, [1], "one flick moves one pill, not one per 60 px");
  // Left after a pause.
  t += GESTURE_GAP_MS + SWIPE_COOLDOWN_MS;
  assert.equal(s.add(-70, 0, t), -1);
});

test("vertical scrolling never swipes, and a pause resets the sum", () => {
  const s = new SwipeAccumulator();
  assert.equal(s.add(30, 100, 0), 0);
  assert.equal(s.add(40, 0, 10), 0);
  assert.equal(s.add(40, 0, 10 + GESTURE_GAP_MS + 1), 0, "the 40 before the pause does not count");
  assert.equal(s.add(30, 0, 20 + GESTURE_GAP_MS + 1), 1);
});

test("dragging left shows the next pill; short or vertical drags are clicks", () => {
  assert.equal(dragDirection(-DRAG_DISTANCE - 1, 0), 1);
  assert.equal(dragDirection(DRAG_DISTANCE + 1, 5), -1);
  assert.equal(dragDirection(-20, 0), 0);
  assert.equal(dragDirection(-50, 60), 0);
});

// ── Claude Code sessions are one stop ─────────────────────────────────────────

const many = ["cc_a", "cc_b", "cc_c", "integration_space", "integration_media"];

test("the session prefix matches island/sessions.ts", () => {
  assert.equal(SESSION_STOP_PREFIX, SESSION_PREFIX);
});

test("all sessions collapse into one stop, kept on the focused one", () => {
  assert.deepEqual(pillStops(many, null), ["cc_a", "integration_space", "integration_media"]);
  assert.deepEqual(pillStops(many, "cc_c"), ["cc_c", "integration_space", "integration_media"]);
});

test("stepping moves past every session at once, and back to the first", () => {
  assert.equal(stepFocus(many, "cc_b", 1), "integration_space");
  assert.equal(stepFocus(many, "cc_c", -1), "integration_media", "wraps round");
  assert.equal(stepFocus(many, "integration_space", -1), "cc_a");
  assert.equal(stepFocus(many, "integration_media", 1), "cc_a");
});

test("moving between sessions does not slide the card", () => {
  assert.equal(slideDirection(many, "cc_a", "cc_c"), 0);
  assert.equal(slideDirection(many, "cc_c", "integration_media"), 1);
  assert.equal(slideDirection(many, "integration_space", "cc_b"), -1);
});

const pill = (id: string, badge: "approval" | "finished" | "error" | null = null) =>
  ({ id, name: id, color: "#fff", badge });
const GROUP = { name: "Claude Code", color: "#E07B53" };

test("the header shows one Claude Code chip for every session", () => {
  const out = sessionChips([pill("cc_a"), pill("cc_b", "finished"), pill("integration_space")], "integration_space", GROUP);
  assert.deepEqual(out.pills.map((p) => p.id), [SESSIONS_CHIP_ID, "integration_space"]);
  assert.equal(out.pills[0].name, "Claude Code · 2");
  assert.equal(out.pills[0].badge, "finished");
  assert.equal(out.focusChip, "integration_space");
});

test("the sessions chip opens the focused session, else one waiting on you, else the newest", () => {
  const ps = [pill("cc_a"), pill("cc_b", "approval"), pill("integration_space")];
  assert.equal(sessionChips(ps, "cc_a", GROUP).pills[0].targetId, "cc_a");
  assert.equal(sessionChips(ps, "cc_a", GROUP).focusChip, SESSIONS_CHIP_ID);
  assert.equal(sessionChips(ps, "integration_space", GROUP).pills[0].targetId, "cc_b");
  assert.equal(sessionChips([pill("cc_x"), pill("cc_y")], "z", GROUP).pills[0].targetId, "cc_x");
});

test("an urgent badge wins over news, and one session needs no count", () => {
  const out = sessionChips([pill("cc_a", "finished"), pill("cc_b", "approval"), pill("cc_c", "error")], "cc_a", GROUP);
  assert.equal(out.pills[0].badge, "approval");
  assert.equal(sessionChips([pill("cc_a")], "cc_a", GROUP).pills[0].name, "Claude Code");
});

test("without sessions the pills pass through untouched", () => {
  const out = sessionChips([pill("integration_claude"), pill("integration_space")], "integration_claude", GROUP);
  assert.deepEqual(out.pills.map((p) => [p.id, p.targetId]), [["integration_claude", "integration_claude"], ["integration_space", "integration_space"]]);
  assert.equal(out.focusChip, "integration_claude");
});
