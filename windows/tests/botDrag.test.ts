// A press on the island's Mochi (src/island/botDrag.ts): a click slaps him
// once the button comes up, a drag past DRAG_THRESHOLD carries him out to the
// desktop, and that drag never slaps him first. Run with `npm test`.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { State } from "../src/core/state.ts";
import { DRAG_THRESHOLD } from "../src/mochi/desktopLogic.ts";

/** The window listeners BotDrag installs, by event name (Node has no window events). */
const handlers = new Map<string, (e: unknown) => void>();
(globalThis as unknown as { addEventListener: unknown }).addEventListener = (name: string, fn: (e: unknown) => void) =>
  handlers.set(name, fn);
const { BotDrag } = await import("../src/island/botDrag.ts");

const LEFT_HELD = 1;
const mouse = (x: number, y: number, button = 0, buttons = LEFT_HELD) =>
  ({ clientX: x, clientY: y, button, buttons }) as MouseEvent;

function rig({ pickUp = true } = {}) {
  const log: string[] = [];
  const desktop = {
    carrying: false,
    canPickUp: () => pickUp,
    pickUp(x: number, y: number) {
      log.push(`pickUp:${x},${y}`);
      desktop.carrying = true;
    },
    carry: (x: number, y: number) => log.push(`carry:${x},${y}`),
    carryEnd(x: number, y: number) {
      log.push(`carryEnd:${x},${y}`);
      desktop.carrying = false;
    },
  };
  const host = {
    desktop,
    uploadActive: false,
    engine: { slap: () => log.push("slap") },
    isBotHit: (x: number) => x < 50,
    cancelBotHover: () => log.push("hover-off"),
  };
  const drag = new BotDrag(host as never);
  const move = (e: MouseEvent) => handlers.get("mousemove")?.(e);
  const up = (e: MouseEvent) => handlers.get("mouseup")?.(e);
  return { drag, log, move, up };
}

beforeEach(() => {
  State.mode = "expanded";
  State.view = "overview";
});

test("a click on Mochi slaps him when the button comes up", () => {
  const r = rig();
  assert.equal(r.drag.pressed(mouse(10, 10)), true);
  assert.deepEqual(r.log, [], "nothing yet on the press");
  r.up(mouse(10, 10, 0, 0));
  assert.deepEqual(r.log, ["slap"]);
});

test("a wobble within the threshold is still a click", () => {
  const r = rig();
  r.drag.pressed(mouse(10, 10));
  r.move(mouse(10 + DRAG_THRESHOLD, 10));
  r.up(mouse(10 + DRAG_THRESHOLD, 10, 0, 0));
  assert.deepEqual(r.log, ["slap"]);
});

test("a drag carries him out, and never slaps him", () => {
  const r = rig();
  r.drag.pressed(mouse(10, 10));
  r.move(mouse(30, 10));
  r.move(mouse(40, 60));
  r.up(mouse(45, 90, 0, 0));
  assert.deepEqual(r.log, ["hover-off", "pickUp:30,10", "carry:40,60", "carryEnd:45,90"]);
});

test("no desktop to go to: a drag does nothing, and no slap either", () => {
  const r = rig({ pickUp: false });
  r.drag.pressed(mouse(10, 10));
  r.move(mouse(30, 10));
  r.up(mouse(30, 10, 0, 0));
  assert.deepEqual(r.log, []);
});

test("the greeting draws its own Mochi: that one can't be dragged out", () => {
  State.view = "greeting";
  const r = rig();
  r.drag.pressed(mouse(10, 10));
  r.move(mouse(30, 10));
  assert.deepEqual(r.log, []);
});

test("a press on the compact island opens it, and does not slap", () => {
  State.mode = "compact";
  const r = rig();
  assert.equal(r.drag.pressed(mouse(10, 10)), true);
  r.up(mouse(10, 10, 0, 0));
  assert.deepEqual(r.log, []);
});

test("a press away from Mochi or a right button is not his", () => {
  const r = rig();
  assert.equal(r.drag.pressed(mouse(80, 10)), false);
  assert.equal(r.drag.pressed(mouse(10, 10, 2)), false);
  r.up(mouse(10, 10, 0, 0));
  assert.deepEqual(r.log, []);
});

test("the button let go outside the window: the press is forgotten", () => {
  const r = rig();
  r.drag.pressed(mouse(10, 10));
  r.move(mouse(30, 10, 0, 0));
  r.move(mouse(40, 10));
  assert.deepEqual(r.log, []);
});
