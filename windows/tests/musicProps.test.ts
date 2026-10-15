// Music act props (mochi/musicProps.ts) and poses (mochi/acts.ts "music" and
// "musicCue"): every prop, at every moment, stays inside the island's bot
// canvas and off Mochi's eyes; every pose stays finite and small. Run with
// `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MUSIC_PROPS, drawMusicProp } from "../src/mochi/musicProps.ts";
import { PROP_SCALE } from "../src/mochi/claudeProps.ts";
import { actDurationMs, actEye, actPose, actShowsHands, actFloatsNotes, isOneShot, type ActName } from "../src/mochi/acts.ts";
import { BODY_RY, EYE_H, EYE_SCALE_MAX, EYE_SP, EYE_W, eyeBottom } from "../src/mochi/geometry.ts";
import { BoundsCtx, type Box } from "./boundsCtx.ts";

// Same limits as tests/claudeProps.test.ts: the island's bot canvas around a
// Mochi of R px, and the eyes at their largest.
const R = 30;
const scene = (t: number) => ({ R: R * PROP_SCALE, rx: R * 1.14, ry: R * BODY_RY, t });
const HALF_WIDTH = R / 0.6;
const TOP = -2.9 * R;
const BOTTOM = 1.6 * R;
const PARTICLE = (0.15 * R) ** 2;

const eyeX = Math.sin(EYE_SP) * 1.14 * R;
const eyeHalfW = ((EYE_W * EYE_SCALE_MAX) / 2) * R;
const eyeTop = (Math.sin(0.12) * BODY_RY - (EYE_H * EYE_SCALE_MAX) / 2) * R;
const eyeBot = eyeBottom(0, EYE_SCALE_MAX) * R;
const EYES: Box[] = [-1, 1].map((sd) => ({ x0: sd * eyeX - eyeHalfW, x1: sd * eyeX + eyeHalfW, y0: eyeTop, y1: eyeBot }));
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

function split(key: string): [ActName, string] {
  const [name, variant] = key.split(":");
  return [name as ActName, variant];
}

/** Continuous props over 8.4 s of the free clock; one-shots over their whole length. */
function replay(key: string): { t: number; box: Box }[] {
  const [name, variant] = split(key);
  const end = isOneShot(name) ? actDurationMs(name, variant) / 1000 : 8.4;
  const out: { t: number; box: Box }[] = [];
  for (let t = 0; t <= end + 1e-9; t += 0.05) {
    const x = new BoundsCtx();
    drawMusicProp(x as unknown as CanvasRenderingContext2D, scene(t), name, variant);
    for (const box of x.shapes) out.push({ t, box });
  }
  return out;
}

const fmt = (b: Box) => `x ${(b.x0 / R).toFixed(2)}..${(b.x1 / R).toFixed(2)} R, y ${(b.y0 / R).toFixed(2)}..${(b.y1 / R).toFixed(2)} R`;

for (const key of Object.keys(MUSIC_PROPS)) {
  test(`${key}: draws something, inside the bot canvas`, () => {
    const shapes = replay(key);
    assert.ok(shapes.length > 0, "the prop draws");
    for (const { t, box } of shapes) {
      if ((box.x1 - box.x0) * (box.y1 - box.y0) < PARTICLE) continue;
      const where = `t=${t.toFixed(2)} ${fmt(box)}`;
      assert.ok(box.x0 >= -HALF_WIDTH && box.x1 <= HALF_WIDTH, `${key} leaves the canvas sideways: ${where}`);
      assert.ok(box.y0 >= TOP && box.y1 <= BOTTOM, `${key} leaves the canvas vertically: ${where}`);
    }
  });

  test(`${key}: never covers the eyes`, () => {
    for (const { t, box } of replay(key)) {
      assert.ok(!EYES.some((e) => overlaps(box, e)), `${key} covers an eye at t=${t.toFixed(2)}: ${fmt(box)}`);
    }
  });
}

test("every music pose is finite and stays a small motion", () => {
  for (const key of Object.keys(MUSIC_PROPS)) {
    const [name, variant] = split(key);
    const end = isOneShot(name) ? actDurationMs(name, variant) / 1000 : 8;
    for (let t = 0; t <= end; t += 0.02) {
      const p = actPose(name, variant, t, t);
      for (const [k, v] of Object.entries(p)) assert.ok(Number.isFinite(v), `${key} ${k} at ${t}`);
      assert.ok(Math.abs(p.oy) <= 0.3 && Math.abs(p.ox) <= 0.15, `${key} moves too far at ${t}`);
      assert.ok(Math.abs(p.tilt) <= 0.3 && Math.abs(p.pitch) <= 0.4 && Math.abs(p.yaw) <= 0.45, `${key} turns too far at ${t}`);
      assert.ok(Math.abs(p.sx - 1) <= 0.15 && Math.abs(p.sy - 1) <= 0.15, `${key} squashes too much at ${t}`);
    }
  }
});

test("cues are one-shots that settle back to neutral, the states are continuous", () => {
  assert.equal(isOneShot("musicCue"), true);
  assert.equal(isOneShot("music"), false);
  for (const key of Object.keys(MUSIC_PROPS).filter((k) => k.startsWith("musicCue:"))) {
    const [, variant] = split(key);
    const end = actDurationMs("musicCue", variant) / 1000;
    const p = actPose("musicCue", variant, end, end);
    assert.ok(Math.abs(p.oy) < 1e-6 && Math.abs(p.pitch) < 1e-6 && Math.abs(p.sy - 1) < 1e-6, `${key} ends neutral`);
    assert.equal(actEye("musicCue", variant, end), "happy", `${key} ends happy`);
  }
});

test("only playing brings the hands out; playing and singing float notes", () => {
  assert.equal(actShowsHands({ name: "music", variant: "playing", at: 0 }), true);
  assert.equal(actShowsHands({ name: "music", variant: "singing", at: 0 }), false, "the mic hand is the prop's own");
  assert.equal(actShowsHands({ name: "mail", variant: null, at: 0 }), true);
  assert.equal(actFloatsNotes({ name: "music", variant: "playing", at: 0 }), true);
  assert.equal(actFloatsNotes({ name: "music", variant: "singing", at: 0 }), true);
  assert.equal(actFloatsNotes({ name: "music", variant: "paused", at: 0 }), false, "paused is quiet");
  assert.equal(actFloatsNotes({ name: "musicCue", variant: "change", at: 0 }), false);
});

test("the five picked designs, and only those, have props", () => {
  assert.deepEqual(Object.keys(MUSIC_PROPS).sort(),
    ["music:paused", "music:playing", "music:singing", "musicCue:change", "musicCue:resume"]);
});

test("an unknown variant draws nothing", () => {
  const x = new BoundsCtx();
  drawMusicProp(x as unknown as CanvasRenderingContext2D, scene(0), "music", "dancing");
  drawMusicProp(x as unknown as CanvasRenderingContext2D, scene(0), "music", null);
  assert.equal(x.shapes.length, 0);
});
