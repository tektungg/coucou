// Mochi's music groove (headphones + dance while the Music pill plays). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BEAT, MEDIA_PILL_ID, dancePose, isDancing, noteDue } from "../src/mochi/dance.ts";

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

test("dances only while the Music pill is playing", () => {
  assert.equal(isDancing({ id: MEDIA_PILL_ID, state: "working" }), true);
  assert.equal(isDancing({ id: MEDIA_PILL_ID, state: "idle" }), false); // paused
  assert.equal(isDancing({ id: MEDIA_PILL_ID, state: "finished" }), false); // event card owns the pill
  assert.equal(isDancing({ id: MEDIA_PILL_ID, state: "error" }), false);
  assert.equal(isDancing({ id: "integration_quota", state: "working" }), false);
  assert.equal(isDancing({ id: "cc_abc", state: "working" }), false); // a busy Claude Code session
  assert.equal(isDancing(null), false);
  assert.equal(isDancing(undefined), false);
});

test("lands upright and squashed on every beat", () => {
  for (let k = 0; k < 6; k++) {
    const p = dancePose(k * BEAT);
    assert.ok(near(p.oy, 0) && near(p.tilt, 0) && near(p.ox, 0), `beat ${k} not upright`);
    assert.ok(near(p.sy, 0.93) && near(p.sx, 1.06), `beat ${k} not squashed`);
  }
});

test("hops up between beats and leans to alternating sides", () => {
  const a = dancePose(BEAT * 0.5);
  const b = dancePose(BEAT * 1.5);
  assert.ok(a.oy < -0.08 && b.oy < -0.08, "no hop between beats");
  assert.ok(a.tilt > 0.13 && b.tilt < -0.13, "lean does not alternate");
  // The raised hand is on the side opposite the lean, and only one at a time.
  assert.ok(a.handL > 0.99 && a.handR === 0);
  assert.ok(b.handR > 0.99 && b.handL === 0);
});

test("stays inside the bounds the engine draws for", () => {
  for (let t = 0; t < 10; t += 0.013) {
    const p = dancePose(t);
    assert.ok(p.oy <= 0 && p.oy >= -0.09);
    assert.ok(Math.abs(p.tilt) <= 0.14 && Math.abs(p.ox) <= 0.05 && Math.abs(p.yaw) <= 0.22);
    assert.ok(p.sx >= 1 && p.sx <= 1.06 + 1e-9 && p.sy >= 0.93 - 1e-9 && p.sy <= 1);
    assert.ok(p.handL >= 0 && p.handL <= 1 && p.handR >= 0 && p.handR <= 1);
  }
});

test("moves smoothly frame to frame (no snaps at 60 fps)", () => {
  // Largest per-frame step of each smooth term is ~0.013; the hop's own corner
  // on landing (the bounce hitting the ground) stays under 0.01 of R.
  const dt = 1 / 60;
  let prev = dancePose(0);
  for (let t = dt; t < 8; t += dt) {
    const p = dancePose(t);
    assert.ok(Math.abs(p.oy - prev.oy) < 0.01, `oy jumps at ${t}`);
    assert.ok(Math.abs(p.tilt - prev.tilt) < 0.015, `tilt jumps at ${t}`);
    assert.ok(Math.abs(p.sy - prev.sy) < 0.015, `sy jumps at ${t}`);
    prev = p;
  }
});

test("floats one note every two beats, whatever the frame rate", () => {
  for (const fps of [30, 60, 144]) {
    const dt = 1 / fps;
    const span = BEAT * 2 * 10; // bars end at 2B, 4B … 20B
    const start = 0.001;
    const frames = Math.ceil((span - start) / dt);
    let notes = 0;
    let prev = start;
    for (let i = 1; i <= frames; i++) {
      const t = start + i * dt;
      if (noteDue(prev, t)) notes++;
      prev = t;
    }
    assert.equal(notes, 10, `${fps} fps gave ${notes} notes`);
  }
  assert.equal(noteDue(1, 1), false);
  assert.equal(noteDue(2, 1), false); // clock went backwards
});
