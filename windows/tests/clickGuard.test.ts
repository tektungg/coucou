// The click guard on decision cards. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLICK_GUARD_MS, createClickGuard } from "../src/views/clickGuard.ts";

/** A guard on a clock the test moves by hand, already showing `key`. */
function shown(key: string | null) {
  let t = 1_000;
  const guard = createClickGuard(() => t);
  guard.arm(key);
  return { guard, advance: (ms: number) => (t += ms) };
}

test("a fresh request ignores clicks, then takes them", () => {
  const { guard, advance } = shown("req-1");
  assert.equal(guard.allows(), false);
  advance(CLICK_GUARD_MS - 1);
  assert.equal(guard.allows(), false);
  advance(1);
  assert.equal(guard.allows(), true);
});

test("re-rendering the same request does not restart the clock", () => {
  const { guard, advance } = shown("req-1");
  advance(CLICK_GUARD_MS);
  guard.arm("req-1");
  assert.equal(guard.allows(), true);
});

test("a new request (or the next question) restarts the clock", () => {
  const { guard, advance } = shown("req-1~0");
  advance(CLICK_GUARD_MS);
  guard.arm("req-1~1");
  assert.equal(guard.allows(), false, "the click that answered question 1 lands on question 2");
});

test("nothing on screen yet guards nothing", () => {
  assert.equal(shown(null).guard.allows(), true);
});

test("wrap runs the action only once the card has settled", () => {
  const { guard, advance } = shown("req-1");
  const decided: string[] = [];
  const allow = guard.wrap(() => decided.push("allow"));
  allow();
  assert.deepEqual(decided, []);
  advance(CLICK_GUARD_MS);
  allow();
  assert.deepEqual(decided, ["allow"]);
});
