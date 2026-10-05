// Island open/close FSM. Run with `npm test` (Node strips the types itself).
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

// fsm.ts schedules through window.setTimeout; in Node the global is the window.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
const { IslandStateMachine } = await import("../src/island/fsm.ts");

type Fsm = InstanceType<typeof IslandStateMachine>;

function fsmIn(state: "hidden" | "petit" | "home"): { fsm: Fsm; seen: string[] } {
  const fsm = new IslandStateMachine();
  const seen: string[] = [];
  if (state === "petit") fsm.reveal();
  if (state === "home") fsm.forceHome();
  fsm.onTransition = (_from, to) => seen.push(to);
  return { fsm, seen };
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

test("hovering the compact island opens it, no click", () => {
  const { fsm, seen } = fsmIn("petit");
  fsm.mouseEntered();
  assert.equal(fsm.state, "home");
  assert.deepEqual(seen, ["home"]);
});

test("hovering the hidden wake strip opens straight to the panel", () => {
  const { fsm } = fsmIn("hidden");
  fsm.mouseEntered();
  assert.equal(fsm.state, "home");
});

test("leaving closes at once", () => {
  const { fsm } = fsmIn("petit");
  fsm.mouseEntered();
  fsm.mouseLeft(true);
  assert.equal(fsm.state, "petit");
});

test("an open panel never closes while the pointer is on it", () => {
  const { fsm } = fsmIn("petit");
  fsm.mouseEntered();
  mock.timers.tick(10 * 60_000);
  assert.equal(fsm.state, "home");
});

test("the chat (non-immediate leave) waits for the auto-close delay", () => {
  const { fsm } = fsmIn("home");
  fsm.homeToPetitDelay = 15;
  fsm.mouseLeft(false);
  mock.timers.tick(14_900);
  assert.equal(fsm.state, "home");
  mock.timers.tick(200);
  assert.equal(fsm.state, "petit");
});

test("coming back before the delay keeps it open", () => {
  const { fsm } = fsmIn("home");
  fsm.mouseLeft(false);
  mock.timers.tick(5_000);
  fsm.mouseEntered();
  mock.timers.tick(60_000);
  assert.equal(fsm.state, "home");
});

test("a pinned alert stays open even when the pointer leaves", () => {
  const { fsm } = fsmIn("home");
  fsm.pinned = true;
  fsm.mouseLeft(true);
  mock.timers.tick(10 * 60_000);
  assert.equal(fsm.state, "home");
});

test("after an immediate close the compact island hides on its usual delay", () => {
  const { fsm } = fsmIn("petit");
  fsm.mouseEntered();
  fsm.mouseLeft(true);
  fsm.mouseLeft(); // what island.ts does once the pointer is outside the compact island
  mock.timers.tick(fsm.petitToHiddenDelay * 1000 + 1);
  assert.equal(fsm.state, "hidden");
});

test("hoverOpens=false keeps the old hover-then-click behaviour", () => {
  const { fsm } = fsmIn("hidden");
  fsm.hoverOpens = false;
  fsm.mouseEntered();
  assert.equal(fsm.state, "petit");
  fsm.mouseEntered();
  assert.equal(fsm.state, "petit");
  fsm.click();
  assert.equal(fsm.state, "home");
});
