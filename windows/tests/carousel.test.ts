// Overview carousel stepping and gestures. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRAG_DISTANCE, GESTURE_GAP_MS, SWIPE_COOLDOWN_MS, SwipeAccumulator, dragDirection, slideDirection,
  stepFocus,
} from "../src/views/carousel.ts";

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
