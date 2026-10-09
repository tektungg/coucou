// Mochi's face and prop geometry (mochi/geometry.ts). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { actDurationMs, actPitchFloor, actPose, actProps, type ActName } from "../src/mochi/acts.ts";
import {
  BODY_RY, ENVELOPE, EYE_SCALE_MAX, envelopeParts, envelopeTop, eyeBottom,
} from "../src/mochi/geometry.ts";

/** Every frame of the Messages act at 100 fps. */
function mailFrames() {
  const end = actDurationMs("mail", null) / 1000;
  const frames: { age: number; show: number; flap: number }[] = [];
  for (let age = 0; age <= end; age += 0.01) frames.push({ age, ...actProps("mail", null, age) });
  return frames;
}

test("eyes sit where drawEyes puts them", () => {
  // Level head: centre sin(0.12) × ry below the body centre, half an eye lower.
  assert.ok(Math.abs(eyeBottom(0) - (Math.sin(0.12) * BODY_RY + 0.135 * Math.cos(0.12))) < 1e-9);
  assert.ok(eyeBottom(-0.5) > eyeBottom(0), "looking down lowers the eyes");
  assert.ok(eyeBottom(0, EYE_SCALE_MAX) > eyeBottom(0), "the surprised pop grows them");
});

test("Messages: the envelope never covers the eyes, at any frame", () => {
  const floor = actPitchFloor("mail");
  assert.equal(floor, 0, "the mail act stops Mochi looking down into the envelope");
  // Worst case: head at the floor, the act's own nod, and the biggest eyes.
  for (const f of mailFrames()) {
    if (f.show <= 0.01) continue; // drawEnvelope skips it
    const pitch = floor + Math.min(0, actPose("mail", null, f.age, 0).pitch);
    const eyes = eyeBottom(pitch, EYE_SCALE_MAX);
    const top = envelopeTop(f.flap, f.show);
    assert.ok(top > eyes + 0.02, `age ${f.age.toFixed(2)}: envelope top ${top.toFixed(3)} R vs eyes ${eyes.toFixed(3)} R`);
  }
});

test("Messages: the open flap and letter still rise out of the pocket", () => {
  const closed = envelopeParts(0);
  const open = envelopeParts(1);
  assert.equal(closed.letterY, null);
  assert.ok(closed.heartY !== null);
  assert.ok(open.letterY !== null && open.letterY < -ENVELOPE.h / 2, "the letter peeks above the top edge");
  assert.ok(open.apex < -ENVELOPE.h / 2, "the flap opens upward");
  assert.ok(envelopeTop(1) < envelopeTop(0), "opening reaches higher than the closed envelope");
});

test("Messages: the envelope stays inside the bot canvas", () => {
  // island.ts: canvas height = width + 40 px, R = 0.3 × width, body centre
  // 20 px + 0.06 R below the middle, so at least 1.6 R of room below the centre.
  const maxShow = Math.max(...mailFrames().map((f) => f.show));
  const bottom = ENVELOPE.cy + (ENVELOPE.h / 2 + (ENVELOPE.w / 2) * Math.sin(-ENVELOPE.tilt)) * maxShow;
  assert.ok(bottom < 1.5, `bottom edge ${bottom.toFixed(3)} R`);
});

test("only the mail act limits the look", () => {
  const others: ActName[] = ["dance", "mic", "catch", "check"];
  for (const n of others) assert.equal(actPitchFloor(n), null, n);
});
