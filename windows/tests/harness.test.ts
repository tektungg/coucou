// The test harness itself (tests/setup.mjs + tests/tauri.mjs). Run with `npm test`.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS helper, no types
import { answer, emit, resetCalls, sent } from "./tauri.mjs";
import { Bridge, IS_TAURI, onEvent } from "../src/core/bridge.ts";

beforeEach(() => resetCalls());

test("the bridge sees the stand-in Tauri", () => {
  assert.equal(IS_TAURI, true);
});

test("commands reach the stand-in with their arguments", async () => {
  await Bridge.fitZoom(1.25);
  assert.deepEqual(sent("fit_zoom"), [{ dpr: 1.25 }]);
});

test("a command answers what the test set", async () => {
  answer("fit_zoom", ({ dpr }: { dpr: number }) => dpr !== 1);
  assert.equal(await Bridge.fitZoom(1.25), true);
  assert.equal(await Bridge.fitZoom(1), false);
});

test("events fired as Rust would reach their listener", async () => {
  const seen: unknown[] = [];
  await onEvent<{ n: number }>("harness-test", (p) => seen.push(p));
  emit("harness-test", { n: 7 });
  assert.deepEqual(seen, [{ n: 7 }]);
});
