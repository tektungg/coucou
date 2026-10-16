// Mochi on the desktop: the pure logic and the life cycle (src/mochi/desktopLogic.ts).
// The first half mirrors tests/DesktopMochiTests.swift; the geometry of the
// window itself (clamping, saved spots, the island's home zone) is tested in
// src-tauri/src/desktop/, where it lives.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BODY_RADIUS_FRACTION, DesktopMochiController, NOTICE_S, PANEL_SIZE, SAME_ACT_SLACK_MS, RETRACT_DELAY_MS, RETURN_DELAY_MS,
  actsKey, agentActive, alertActive, gaze, isOverBody, layerDragTopLeft, liveAct, lookOrigin, packActs,
  pointerDistance, shouldRetractOnLanding, shouldSleep, steadyActs, unpackActs, windowDragTopLeft,
} from "../src/mochi/desktopLogic.ts";
import { actDurationMs } from "../src/mochi/acts.ts";

// ── shouldSleep ───────────────────────────────────────────────────────────────

test("shouldSleep: idle long enough and the pointer far away", () => {
  assert.equal(shouldSleep(5, 300), false, "active agent must not sleep");
  assert.equal(shouldSleep(200, 50), false, "mouse near panel must not sleep");
  assert.equal(shouldSleep(200, 200), true, "long idle + far mouse must sleep");
  assert.equal(shouldSleep(120, 300), false, "exactly at timeout must not sleep");
  assert.equal(shouldSleep(120.1, 300), true, "just over timeout must sleep");
  assert.equal(shouldSleep(200, 150), true, "at distance threshold must sleep");
});

test("agent work keeps him awake, idle and sleeping don't", () => {
  for (const s of ["working", "thinking", "searching", "approval", "question", "finished", "error"]) {
    assert.equal(agentActive(s), true, s);
  }
  assert.equal(agentActive("idle"), false);
  assert.equal(agentActive("sleeping"), false);
});

test("pointer distance: measured with a cursor poll, remembered without one", () => {
  assert.equal(pointerDistance(true, { x: 60, y: 60 }, 0), 0);
  assert.equal(pointerDistance(true, { x: 60 + 150, y: 60 }, 0), 150);
  assert.equal(pointerDistance(true, null, 0), Infinity, "no cursor yet: far");
  // Linux: near while the pointer was over him a moment ago.
  assert.equal(pointerDistance(false, null, 100), 0);
  assert.equal(pointerDistance(false, { x: 60, y: 60 }, 60_000), Infinity);
});

// ── isOverBody ────────────────────────────────────────────────────────────────

test("isOverBody: the round body, not the square window", () => {
  const s = 120;
  const r = s * BODY_RADIUS_FRACTION; // 28.8
  assert.equal(isOverBody({ x: 60, y: 60 }, s), true, "center must be inside body");
  assert.equal(isOverBody({ x: 60 + r - 0.5, y: 60 }, s), true, "inside radius must hit");
  assert.equal(isOverBody({ x: 60 + r + 0.5, y: 60 }, s), false, "outside radius must miss");
  assert.equal(isOverBody({ x: 0, y: 0 }, s), false, "corner must miss");
  const diag = r / Math.SQRT2 - 0.5;
  assert.equal(isOverBody({ x: 60 + diag, y: 60 + diag }, s), true, "diagonal inside must hit");
  assert.equal(PANEL_SIZE, 120);
});

// ── lookOrigin / gaze ─────────────────────────────────────────────────────────

const sign = (v) => (v === 0 ? 0 : v < 0 ? -1 : 1);

/** The Mac test's AppKit points (y up from the menu-bar screen's bottom) → y down. */
const topDown = (p, desktopTop) => ({ x: p.x, y: desktopTop - p.y });

test("lookOrigin: the window centre, in desktop coordinates", () => {
  // Panel at (200, 300) from the top-left of the desktop.
  assert.deepEqual(lookOrigin(200, 300, 120), { x: 260, y: 360 });
  // On a secondary screen to the right: x stays global, not screen-relative.
  assert.deepEqual(lookOrigin(1540, 100, 120), { x: 1600, y: 160 });
});

test("gaze signs across a real arrangement of screens", () => {
  // Menu-bar MacBook 1512×982 at (0,0); external 2560×1440 above it at
  // (-500, 982); portrait 1080×1920 on the left at (-1080, -600). AppKit
  // coordinates as in the Swift test, turned y-down like a PC reports them.
  const top = 982;
  const look = (bot, mouse) => {
    const g = gaze(topDown(bot, top), topDown(mouse, top));
    return [sign(g.lookX), sign(g.lookY)];
  };
  // Mochi in the island at the top of the external screen above.
  const islandOnTop = { x: 780, y: 2422 - 16 };
  assert.deepEqual(look(islandOnTop, { x: 1400, y: 100 }), [1, -1], "cursor on the MacBook below-right");
  assert.deepEqual(look(islandOnTop, { x: -1000, y: 0 }), [-1, -1], "cursor on the portrait screen");
  assert.deepEqual(look(islandOnTop, { x: 780, y: 2500 }), [0, 1], "cursor above Mochi");
  // Mochi on the desktop of the portrait screen, cursor on the external screen above.
  const panelMin = topDown({ x: -700, y: -200 + 120 }, top); // AppKit minY is the bottom edge
  const desktopOnLeft = lookOrigin(panelMin.x, panelMin.y, 120);
  const mouseAbove = topDown({ x: 1000, y: 2000 }, top);
  assert.ok(mouseAbove.x > desktopOnLeft.x && mouseAbove.y < desktopOnLeft.y,
    "desktop Mochi looks right and up at a cursor on another screen");
  const g = gaze(desktopOnLeft, mouseAbove);
  assert.ok(g.lookX > 0 && g.lookY > 0);
});

// ── shouldRetractOnLanding / alerts ───────────────────────────────────────────

test("shouldRetractOnLanding", () => {
  assert.equal(shouldRetractOnLanding(true), true, "must retract when alert is active on landing");
  assert.equal(shouldRetractOnLanding(false), false, "must not retract when no alert on landing");
});

test("a permission or a question sends him back to the island", () => {
  const none = { pendingApproval: null, pendingQuestion: null };
  assert.equal(alertActive({ ...none, tasks: [{ state: "working" }] }), false);
  assert.equal(alertActive({ ...none, pendingApproval: { requestId: "r" }, tasks: [] }), true);
  assert.equal(alertActive({ ...none, tasks: [{ state: "idle" }, { state: "question" }] }), true);
});

test("a question card waiting for its answers sends him back too", () => {
  // This build's AskUserQuestion card (State.pendingQuestion), even before the
  // session's pill has turned to "question".
  const s = { pendingApproval: null, pendingQuestion: { requestId: "q" }, tasks: [{ state: "working" }] };
  assert.equal(alertActive(s), true);
});

// ── Acts across windows ───────────────────────────────────────────────────────

test("a one-shot crosses to the desktop as its age, on the other window's clock", () => {
  const mail = { name: "mail", variant: null, at: 10_000 };
  const packed = packActs(mail, null, 10_500);
  assert.deepEqual(packed.oneShot, { name: "mail", variant: null, ageMs: 500 });
  // The desktop window's clock reads 90 000 when the snapshot lands.
  const there = unpackActs(packed, 90_000);
  assert.deepEqual(there.oneShot, { name: "mail", variant: null, at: 89_500 });
  assert.equal(liveAct(there, 90_000), there.oneShot);
});

test("a one-shot that is over is not sent, and the continuous act takes over", () => {
  const mail = { name: "mail", variant: null, at: 0 };
  const music = { name: "music", variant: "playing" };
  const over = packActs(mail, music, actDurationMs("mail", null));
  assert.equal(over.oneShot, null);
  assert.deepEqual(liveAct(unpackActs(over, 5), 5), { name: "music", variant: "playing", at: 0 });
  // Not yet started (a clock behind the event): not sent either.
  assert.equal(packActs({ ...mail, at: 100 }, null, 50).oneShot, null);
});

test("on the desktop, a one-shot ends by itself and gives way to the continuous act", () => {
  const packed = packActs({ name: "catch", variant: null, at: 0 }, { name: "mic", variant: null }, 100);
  const there = unpackActs(packed, 1_000);
  const end = there.oneShot.at + actDurationMs("catch", null);
  assert.equal(liveAct(there, end - 1)?.name, "catch");
  assert.equal(liveAct(there, end)?.name, "mic");
  assert.equal(liveAct(unpackActs({ oneShot: null, continuous: null }, 0), 0), null);
});

test("a one-shot sent again keeps the start it is already playing from", () => {
  const mail = { name: "mail", variant: null, at: 1_000 };
  const first = unpackActs(packActs(mail, null, 1_100), 50_000);
  // Sent again with an unrelated change; this time the trip took 3 ms longer.
  const again = unpackActs(packActs(mail, null, 1_400), 50_303);
  assert.notEqual(again.oneShot.at, first.oneShot.at);
  assert.equal(steadyActs(first, again).oneShot, first.oneShot, "same start: the engine does not restart it");
  // A new mail, later: its own start.
  const next = { ...mail, at: 1_000 + SAME_ACT_SLACK_MS + 500 };
  const later = unpackActs(packActs(next, null, next.at), 51_000);
  assert.equal(steadyActs(first, later).oneShot, later.oneShot);
  // Another act altogether, or none: never kept.
  const music = unpackActs(packActs(null, { name: "music", variant: "playing" }, 0), 0);
  assert.equal(steadyActs(first, music).oneShot, null);
});

test("the snapshot key ignores a one-shot's age, not a new one-shot", () => {
  const mail = { name: "mail", variant: null, at: 1_000 };
  const early = packActs(mail, null, 1_100);
  const later = packActs(mail, null, 2_000);
  assert.notDeepEqual(early, later);
  assert.equal(actsKey(early, mail.at), actsKey(later, mail.at));
  const again = { ...mail, at: 1_900 };
  assert.notEqual(actsKey(packActs(again, null, 2_000), again.at), actsKey(later, mail.at));
});

// ── Linux drags ───────────────────────────────────────────────────────────────

test("layer-shell drag: display coordinates once the overlay is up", () => {
  const origin = { x: 500, y: 300 };
  const grab = { x: 60, y: 62 };
  // Not applied yet: the pointer is still relative to the small surface.
  assert.deepEqual(layerDragTopLeft(origin, { x: 70, y: 62 }, grab, false), { x: 510, y: 300 });
  // Applied: the pointer reads in display coordinates.
  assert.deepEqual(layerDragTopLeft(origin, { x: 900, y: 462 }, grab, true), { x: 840, y: 400 });
});

test("X11 drag: screen delta, in physical pixels", () => {
  assert.deepEqual(
    windowDragTopLeft({ x: 1000, y: 600 }, { x: 520, y: 310 }, { x: 500, y: 300 }, 2),
    { x: 1040, y: 620 },
  );
});

// ── Life cycle ────────────────────────────────────────────────────────────────

/** A world the controller acts on, with manual flights and timers. */
function world({ alert = false, flyOutOk = true } = {}) {
  const log = [];
  const timers = [];
  const flights = [];
  const w = {
    alert,
    away: false,
    log,
    /** Lands the oldest pending flight. */
    async land(result) {
      const f = flights.shift();
      assert.ok(f, "a flight should be in the air");
      f.resolve(result ?? f.defaultResult);
      await new Promise((r) => setImmediate(r));
    },
    get flying() {
      return flights.map((f) => f.kind);
    },
    /** Runs the timers due within `ms`. */
    async tick(ms) {
      const due = timers.filter((t) => t.ms <= ms);
      for (const t of due) timers.splice(timers.indexOf(t), 1);
      for (const t of due) t.fn();
      await new Promise((r) => setImmediate(r));
    },
    port: {
      flyOut: () => new Promise((resolve) => flights.push({ kind: "out", resolve, defaultResult: flyOutOk })),
      flyHome: (forget) => {
        log.push(forget ? "home-forget" : "home-keep");
        return new Promise((resolve) => flights.push({ kind: "home", resolve, defaultResult: true }));
      },
      setAway: (a) => {
        w.away = a;
      },
      emote: (e) => log.push(`emote:${e}`),
      play: (s) => log.push(`sound:${s}`),
      alertActive: () => w.alert,
      revealIsland: () => log.push("reveal"),
      later: (fn, ms) => timers.push({ fn, ms }),
    },
  };
  w.c = new DesktopMochiController(w.port);
  return w;
}

/** The alert goes up or is answered. */
function raise(w, on) {
  w.alert = on;
  w.c.updateAlert(on);
}

/** He lives on the desktop and has flown out to his spot. */
async function onDesktop(w) {
  w.c.enabled = true;
  void w.c.launchFlyIfNeeded();
  await w.land();
}

/** On his spot when an alert goes up. */
async function alertOnDesktop() {
  const w = world();
  await onDesktop(w);
  raise(w, true);
  return w;
}

test("launch: flies out to his spot only if he lives on the desktop", async () => {
  const w = world();
  await w.c.launchFlyIfNeeded();
  assert.equal(w.c.phase, "home", "not enabled: stays home");
  assert.deepEqual(w.flying, []);

  w.c.enabled = true;
  void w.c.launchFlyIfNeeded();
  assert.equal(w.c.phase, "flyingOut");
  assert.equal(w.away, true, "the island's Mochi hides as he leaves");
  await w.land();
  assert.equal(w.c.phase, "onDesktop");
});

test("launch: a spot on a display that is gone keeps him home", async () => {
  const w = world({ flyOutOk: false });
  w.c.enabled = true;
  void w.c.launchFlyIfNeeded();
  await w.land();
  assert.equal(w.c.phase, "home");
  assert.equal(w.c.enabled, false);
  assert.equal(w.away, false);
});

test("launch during an alert waits in the island, then flies out once answered", async () => {
  const w = world({ alert: true });
  w.c.enabled = true;
  w.c.updateAlert(true);
  await w.c.launchFlyIfNeeded();
  assert.equal(w.c.phase, "atNotchForAlert");
  assert.deepEqual(w.flying, []);

  raise(w, false);
  assert.equal(w.c.phase, "home");
  await w.tick(RETURN_DELAY_MS);
  assert.deepEqual(w.flying, ["out"]);
  await w.land();
  assert.equal(w.c.phase, "onDesktop");
});

test("alert on the desktop: surprised, flies to the island, comes back once answered", async () => {
  const w = await alertOnDesktop();
  assert.equal(w.c.phase, "retracting");
  assert.ok(w.log.includes("emote:surprised"));
  await w.tick(RETRACT_DELAY_MS);
  assert.deepEqual(w.flying, ["home"]);
  assert.ok(w.log.includes("home-keep"), "he keeps his spot");
  await w.land();
  assert.equal(w.c.phase, "atNotchForAlert");
  assert.equal(w.away, false, "the island's Mochi shows the alert");
  assert.ok(w.log.includes("reveal"));
  assert.equal(w.c.enabled, true);

  raise(w, false);
  await w.tick(RETURN_DELAY_MS);
  await w.land();
  assert.equal(w.c.phase, "onDesktop");
});

test("alert answered before he takes off: he never leaves his spot", async () => {
  const w = await alertOnDesktop();
  raise(w, false);
  assert.equal(w.c.phase, "alertResolvedDuringRetract");
  await w.tick(RETRACT_DELAY_MS);
  assert.equal(w.c.phase, "onDesktop");
  assert.deepEqual(w.flying, []);
});

test("alert answered during the flight to the island: straight back out", async () => {
  const w = await alertOnDesktop();
  await w.tick(RETRACT_DELAY_MS);
  assert.deepEqual(w.flying, ["home"]);
  raise(w, false);
  assert.equal(w.c.phase, "alertResolvedDuringRetract");
  await w.land();
  assert.deepEqual(w.flying, ["out"], "relaunched as soon as he reached the island");
  await w.land();
  assert.equal(w.c.phase, "onDesktop");
});

test("an alert that went up during the flight out sends him right back", async () => {
  const w = world();
  w.c.enabled = true;
  void w.c.launchFlyIfNeeded();
  raise(w, true); // ignored mid-flight
  assert.equal(w.c.phase, "flyingOut");
  await w.land();
  assert.equal(w.c.phase, "retracting");
  await w.tick(RETRACT_DELAY_MS);
  assert.deepEqual(w.flying, ["home"]);
});

test("dropped on the desktop from the island: lands with a pop", () => {
  const w = world();
  w.c.installed();
  assert.equal(w.c.phase, "onDesktop");
  assert.equal(w.c.enabled, true);
  assert.equal(w.away, true);
  assert.ok(w.log.includes("sound:pop"));
  assert.ok(w.log.includes("emote:happy"));
});

test("dropped on the desktop while an alert is up: turns right back", () => {
  const w = world({ alert: true });
  w.c.installed();
  assert.equal(w.c.phase, "retracting");
});

test("double click or dropped on the island: home for good", async () => {
  const w = world();
  w.c.installed();
  void w.c.flyHome();
  assert.equal(w.c.phase, "home");
  assert.equal(w.c.enabled, false);
  assert.ok(w.log.includes("home-forget"));
  await w.land();
  assert.equal(w.away, false);
  assert.ok(w.log.includes("sound:peek"));

  // An alert now leaves him in the island.
  raise(w, true);
  assert.equal(w.c.phase, "home");
});

test("sent home in the instant before an alert takes him: home wins", async () => {
  const w = world();
  w.c.installed();
  raise(w, true);
  assert.equal(w.c.phase, "retracting");
  void w.c.flyHome();
  assert.equal(w.c.phase, "home");
  await w.land();
  await w.tick(RETRACT_DELAY_MS);
  assert.deepEqual(w.flying, [], "the retract has nothing left to do");
  raise(w, false);
  await w.tick(RETURN_DELAY_MS);
  assert.deepEqual(w.flying, [], "and he doesn't come back out");
});

test("a finished task gets a happy jump, only on the desktop", () => {
  const w = world();
  w.c.updateState("working");
  w.c.updateState("finished");
  assert.ok(!w.log.includes("emote:happy"), "home: the island's Mochi celebrates");
  w.c.installed();
  w.log.length = 0;
  w.c.updateState("working");
  w.c.updateState("finished");
  w.c.updateState("finished");
  assert.deepEqual(w.log, ["emote:happy"]);
});

test("an integration's alert: he looks up from his spot, and stays there", () => {
  const w = world();
  w.c.notice();
  assert.deepEqual(w.log, [], "home: the island shows it, nothing to do here");
  w.c.installed();
  w.log.length = 0;
  w.c.notice();
  assert.deepEqual(w.log, ["emote:surprised"]);
  assert.equal(w.c.phase, "onDesktop");
  assert.deepEqual(w.flying, []);
  assert.ok(NOTICE_S > 0 && NOTICE_S < 2, "a glance, not a long emote");
});
