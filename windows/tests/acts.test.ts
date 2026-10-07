// Mochi's acts per pill (mochi/acts.ts). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actBursts, actDurationMs, actEye, actFor, actKey, actPose, actProps, continuousAct, detectAct,
  endFade, isOneShot, newShelfItem, CATCH_LAND, CHECK_DONE, MAIL_OPEN, NEUTRAL,
  type ActName, type Pose,
} from "../src/mochi/acts.ts";

const file = (path: string, modified = 1000) => ({ path, name: path, size: 1, modified, kind: "image" });
const shelf = (screenshots: object[] = [], downloads: object[] = [], pinned: object[] = []) =>
  ({ pinned, screenshots, downloads });
const space = (...done: boolean[]) => ({
  date: "2026-10-07", totalPoint: 8, totalDone: 0,
  items: done.map((d, i) => ({ name: `T${i}`, point: 1, done: d, kind: "sprint", status: d ? "done" : "open" })),
  warnings: [],
});

// ── Triggers ──────────────────────────────────────────────────────────────────

test("Messages: a new toast plays the envelope, nothing else does", () => {
  const data = { messages: [] };
  assert.deepEqual(detectAct("integration_messages", data, data, { success: true }), { name: "mail", variant: null });
  assert.equal(detectAct("integration_messages", data, data, { success: false }), null);
  assert.equal(detectAct("integration_messages", data, data, null), null); // a dismiss, the backlog
  assert.equal(detectAct("integration_messages", null, data, undefined), null);
});

test("Shelf: catches a new screenshot, download or pin", () => {
  const before = shelf([file("a.png")], [file("x.zip")]);
  assert.deepEqual(detectAct("integration_shelf", before, shelf([file("b.png"), file("a.png")], [file("x.zip")]), null),
    { name: "catch", variant: null });
  assert.ok(newShelfItem(before, shelf([file("a.png")], [file("y.pdf"), file("x.zip")])));
  assert.ok(newShelfItem(before, shelf([file("a.png")], [file("x.zip")], [file("dropped.txt")])));
  assert.ok(newShelfItem(before, shelf([file("a.png", 2000)], [file("x.zip")])), "a file saved again counts");
});

test("Shelf: no catch on the first load, the same data or a file leaving", () => {
  const before = shelf([file("a.png"), file("b.png")], [file("x.zip")]);
  assert.equal(detectAct("integration_shelf", null, before, null), null);
  assert.equal(detectAct("integration_shelf", before, before, null), null);
  assert.equal(detectAct("integration_shelf", before, shelf([file("a.png")], [file("x.zip")]), null), null);
  assert.equal(detectAct("integration_shelf", before, shelf(), null), null); // aged out of the 3 days
  assert.equal(detectAct("integration_shelf", before, shelf([file("a.png", 500)], [file("x.zip")]), null), null);
  assert.equal(detectAct("integration_shelf", before, {}, null), null); // malformed
});

test("Space: a check when an item gets done, the big one when all are", () => {
  assert.deepEqual(detectAct("integration_space", space(false, false), space(true, false), null),
    { name: "check", variant: null });
  assert.deepEqual(detectAct("integration_space", space(true, false), space(true, true), null),
    { name: "check", variant: "all" });
  assert.equal(detectAct("integration_space", null, space(true, true), null), null); // first load
  assert.equal(detectAct("integration_space", space(true), space(true), null), null);
  assert.equal(detectAct("integration_space", space(true, true), space(false, false, false), null), null); // new day
  assert.equal(detectAct("integration_space", space(true), {}, null), null);
});

test("Music and Audio never start a one-shot", () => {
  assert.equal(detectAct("integration_media", { playing: false }, { playing: true }, null), null);
  assert.equal(detectAct("integration_audio", { micUsers: [] }, { micUsers: ["Discord"] }, null), null);
});

test("continuous acts: dancing to music, the headset while an app uses the mic", () => {
  assert.deepEqual(continuousAct({ id: "integration_media", state: "working" }, {}), { name: "dance", variant: null });
  assert.equal(continuousAct({ id: "integration_media", state: "idle" }, {}), null);
  const audio = { id: "integration_audio", state: "idle" as const };
  assert.deepEqual(continuousAct(audio, { micUsers: ["Discord"], input: { volume: 1, muted: false } }),
    { name: "mic", variant: null });
  assert.deepEqual(continuousAct(audio, { micUsers: ["Zoom"], input: { volume: 1, muted: true } }),
    { name: "mic", variant: "muted" });
  assert.equal(continuousAct(audio, { micUsers: [], input: { volume: 1, muted: false } }), null);
  assert.equal(continuousAct(audio, null), null);
});

test("actFor: a live one-shot first, then the continuous act, expiring by time", () => {
  const at = 10_000;
  const shelfTask = { id: "integration_shelf", state: "idle" as const, act: { name: "catch" as const, variant: null, at } };
  assert.equal(actFor(shelfTask, {}, at + 100)?.name, "catch");
  assert.equal(actFor(shelfTask, {}, at + actDurationMs("catch", null)), null);
  assert.equal(actFor(shelfTask, {}, at - 1), null);
  const audioTask = { id: "integration_audio", state: "idle" as const, act: null };
  assert.deepEqual(actFor(audioTask, { micUsers: ["Discord"] }, at), { name: "mic", variant: null, at: 0 });
  assert.equal(actFor(null, {}, at), null);
});

test("one-shots are told apart by kind, not by their timestamp", () => {
  for (const n of ["mail", "catch", "check"] as const) assert.equal(isOneShot(n), true);
  for (const n of ["dance", "mic"] as const) assert.equal(isOneShot(n), false);
  // A page that just loaded can stamp an act at or below 0 ms; it is still a one-shot.
  const task = { id: "integration_shelf", state: "idle" as const, act: { name: "catch" as const, variant: null, at: -200 } };
  assert.equal(actFor(task, {}, 100)?.name, "catch");
});

test("actKey: a variant change (muting) is the same act, a new event is not", () => {
  assert.equal(actKey({ name: "mic", variant: null, at: 0 }), actKey({ name: "mic", variant: "muted", at: 0 }));
  assert.notEqual(actKey({ name: "mail", variant: null, at: 1 }), actKey({ name: "mail", variant: null, at: 2 }));
  assert.equal(actKey(null), "");
});

// ── Poses and props ───────────────────────────────────────────────────────────

const ALL: [ActName, string | null][] = [
  ["dance", null], ["mic", null], ["mic", "muted"], ["mail", null], ["catch", null], ["check", null], ["check", "all"],
];
const span = (name: ActName, variant: string | null) => {
  const d = actDurationMs(name, variant) / 1000;
  return Number.isFinite(d) ? d : 6;
};

test("every pose stays inside the bounds the engine draws for", () => {
  for (const [name, variant] of ALL) {
    for (let a = 0; a <= span(name, variant); a += 0.011) {
      const p = actPose(name, variant, a, a + 3.7);
      const where = `${name}/${variant} at ${a.toFixed(3)}`;
      assert.ok(p.oy <= 0.05 && p.oy >= -0.3, `oy ${where}`);
      assert.ok(Math.abs(p.tilt) <= 0.15 && Math.abs(p.ox) <= 0.06, `tilt/ox ${where}`);
      assert.ok(Math.abs(p.yaw) <= 0.25 && Math.abs(p.pitch) <= 0.5, `yaw/pitch ${where}`);
      assert.ok(p.sx >= 0.95 && p.sx <= 1.11 && p.sy >= 0.87 && p.sy <= 1.05, `scale ${where}`);
      assert.ok(p.handL >= 0 && p.handL <= 1 && p.handR >= 0 && p.handR <= 1, `hands ${where}`);
    }
  }
});

test("every pose moves smoothly at 60 fps (no snaps)", () => {
  const keys: (keyof Pose)[] = ["oy", "ox", "tilt", "yaw", "pitch", "sx", "sy", "handL", "handR"];
  const dt = 1 / 60;
  for (const [name, variant] of ALL) {
    let prev = actPose(name, variant, 0, 3);
    for (let i = 1; i * dt <= span(name, variant); i++) {
      const p = actPose(name, variant, i * dt, 3 + i * dt);
      for (const k of keys) {
        // Hands may sweep faster (they swing out); body terms stay under 0.04 per frame.
        const limit = k === "handL" || k === "handR" ? 0.12 : 0.04;
        assert.ok(Math.abs(p[k] - prev[k]) < limit, `${name}/${variant} ${k} jumps at frame ${i}`);
      }
      prev = p;
    }
  }
});

test("one-shots start and end on the neutral pose", () => {
  for (const [name, variant] of ALL.filter(([n]) => n === "mail" || n === "catch" || n === "check")) {
    const d = span(name, variant);
    for (const a of [0, d]) {
      const p = actPose(name, variant, a, 0);
      for (const k of Object.keys(NEUTRAL) as (keyof Pose)[]) {
        assert.ok(Math.abs(p[k] - NEUTRAL[k]) < 1e-6, `${name}/${variant} ${k} not neutral at ${a}`);
      }
    }
    assert.equal(endFade(name, variant, d), 0);
    assert.equal(actProps(name, variant, d).show, 0);
  }
});

test("the beats of each one-shot land in order", () => {
  // Envelope: closed until it opens, open after.
  assert.equal(actProps("mail", null, 0.5).flap, 0);
  assert.equal(actProps("mail", null, MAIL_OPEN).flap, 1);
  assert.equal(actEye("mail", null, 0.3), "dot");
  assert.equal(actEye("mail", null, 1.5), "happy");
  // Box: the file falls, lands, Mochi looked up before and is happy after.
  assert.ok(actProps("catch", null, 0.4).fall < 1);
  assert.equal(actProps("catch", null, CATCH_LAND).fall, 1);
  assert.ok(actPose("catch", null, 0.5, 0).pitch > 0.3, "looks up at the file");
  assert.equal(actEye("catch", null, CATCH_LAND + 0.1), "happy");
  // Check: the mark is drawn by CHECK_DONE; stars only when everything is done.
  assert.equal(actProps("check", null, 0.3).stroke, 0);
  assert.equal(actProps("check", null, CHECK_DONE).stroke, 1);
  assert.equal(actEye("check", null, 1.2), "happy");
  assert.equal(actEye("check", "all", 1.2), "star");
  assert.equal(actEye("dance", null, 0), "happy");
  assert.equal(actEye("mic", null, 0), null);
});

test("particle bursts fire once each, at their moment, whatever the frame rate", () => {
  const total = (name: ActName, variant: string | null, fps: number) => {
    const out: Record<string, number> = {};
    let prev = 0;
    for (let i = 1; i / fps <= span(name, variant) + 1 / fps; i++) {
      for (const b of actBursts(name, variant, prev, i / fps)) out[b.type] = (out[b.type] ?? 0) + b.count;
      prev = i / fps;
    }
    return out;
  };
  for (const fps of [30, 60, 144]) {
    assert.deepEqual(total("mail", null, fps), { heart: 4 });
    assert.deepEqual(total("catch", null, fps), { spark: 5 });
    assert.deepEqual(total("check", null, fps), { star: 3 });
    assert.deepEqual(total("check", "all", fps), { star: 10, spark: 6 });
    assert.deepEqual(total("dance", null, fps), {});
  }
});
