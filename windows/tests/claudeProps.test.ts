// Claude Code act props (mochi/claudeProps.ts): every prop, at every moment of
// its animation, stays inside the island's bot canvas and off Mochi's eyes.
// tests/boundsCtx.ts records each shape's bounding box. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_PROPS, PROP_SCALE, drawClaudeProp } from "../src/mochi/claudeProps.ts";
import { BODY_RY, EYE_H, EYE_SCALE_MAX, EYE_SP, EYE_W, eyeBottom } from "../src/mochi/geometry.ts";
import { BoundsCtx, type Box } from "./boundsCtx.ts";

// The island's Mochi: R in px for the smallest and largest bot of the views.
const R = 30;
const scene = (t: number) => ({ R: R * PROP_SCALE, rx: R * 1.14, ry: R * BODY_RY, t });

// The bot canvas is diameter / 0.6 wide (island.ts) and R = 0.3 × that width,
// so it reaches 1/0.6 R to each side. Above, it has more than 2.9 R in every view.
const HALF_WIDTH = R / 0.6;
const TOP = -2.9 * R;
const BOTTOM = 1.6 * R;
/** Confetti and steam may drift out and be clipped, like the engine's particles. */
const PARTICLE = (0.15 * R) ** 2;

const eyeX = Math.sin(EYE_SP) * 1.14 * R;
const eyeHalfW = ((EYE_W * EYE_SCALE_MAX) / 2) * R;
const eyeTop = (Math.sin(0.12) * BODY_RY - (EYE_H * EYE_SCALE_MAX) / 2) * R;
const eyeBot = eyeBottom(0, EYE_SCALE_MAX) * R;
const EYES: Box[] = [-1, 1].map((sd) => ({ x0: sd * eyeX - eyeHalfW, x1: sd * eyeX + eyeHalfW, y0: eyeTop, y1: eyeBot }));
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

function replay(key: string): { t: number; box: Box }[] {
  const [name, ...rest] = key.split(":");
  const out: { t: number; box: Box }[] = [];
  for (let t = 0; t <= 8.4; t += 0.1) {
    const x = new BoundsCtx();
    drawClaudeProp(x as unknown as CanvasRenderingContext2D, scene(t), name, rest.join(":"));
    for (const box of x.shapes) out.push({ t, box });
  }
  return out;
}

for (const key of Object.keys(CLAUDE_PROPS)) {
  test(`${key}: draws something, inside the bot canvas`, () => {
    const shapes = replay(key);
    assert.ok(shapes.length > 0, "the prop draws");
    for (const { t, box } of shapes) {
      if ((box.x1 - box.x0) * (box.y1 - box.y0) < PARTICLE) continue;
      const where = `t=${t.toFixed(1)} box x ${(box.x0 / R).toFixed(2)}..${(box.x1 / R).toFixed(2)} R, y ${(box.y0 / R).toFixed(2)}..${(box.y1 / R).toFixed(2)} R`;
      assert.ok(box.x0 >= -HALF_WIDTH && box.x1 <= HALF_WIDTH, `${key} leaves the canvas sideways: ${where}`);
      assert.ok(box.y0 >= TOP && box.y1 <= BOTTOM, `${key} leaves the canvas vertically: ${where}`);
    }
  });

  test(`${key}: never covers the eyes`, () => {
    for (const { t, box } of replay(key)) {
      assert.ok(!EYES.some((e) => overlaps(box, e)),
        `${key} covers an eye at t=${t.toFixed(1)}: x ${(box.x0 / R).toFixed(2)}..${(box.x1 / R).toFixed(2)} R, y ${(box.y0 / R).toFixed(2)}..${(box.y1 / R).toFixed(2)} R`);
    }
  });
}

test("an unknown variant draws nothing", () => {
  const x = new BoundsCtx();
  drawClaudeProp(x as unknown as CanvasRenderingContext2D, scene(0), "claude", "finished");
  drawClaudeProp(x as unknown as CanvasRenderingContext2D, scene(0), "claude", null);
  assert.equal(x.shapes.length, 0);
});
