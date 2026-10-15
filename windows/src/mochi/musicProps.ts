// Music acts (acts.ts "music" and "musicCue"): HD props for the Music pill,
// drawn in code in the claudeProps.ts style (gradients, soft outline, shadow,
// gloss, Mochi's own hands). Variant codes: a digit per state (1 playing,
// 2 singing, 3 paused, 4 track change, 5 resume), a letter per design.
// dev/music-acts-options.html shows them all; tests/musicProps.test.ts keeps
// every prop inside the island's bot canvas and off the eyes.
//
// Body space, origin at Mochi's centre, +y down. `rx`/`ry` place things on the
// body, `s.R` (R × PROP_SCALE) sizes them. The eyes sit at |x| 0.26–0.57 R,
// y −0.06–0.27 R: props stay below or beside that box, or above the head.

import { BEAT } from "./acts.ts";
import { fillLine, hand, lin, rad, rr, saw, shadowed, shine, wave, type Ctx, type Scene } from "./claudeProps.ts";

const PINK: [number, string][] = [[0, "#ffc2d6"], [0.5, "#ff8fb1"], [1, "#d9577f"]];
const CHROME: [number, string][] = [[0, "#ffffff"], [0.35, "#d7dae2"], [0.7, "#8d93a1"], [1, "#e9ebf0"]];
const GRAPHITE: [number, string][] = [[0, "#6a6f80"], [1, "#2a2d36"]];
const CREAM: [number, string][] = [[0, "#fff6e6"], [1, "#f1d9b5"]];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (v: number) => { const c = clamp01(v); return c * c * (3 - 2 * c); };
/** 1 on each beat, decaying until the next. */
const onBeat = (t: number, k = 6) => Math.exp(-saw(t, BEAT) * k);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

// ── Shared pieces ─────────────────────────────────────────────────────────────

/** One ear cup, outward to the `side`; `glow` lights the pink ring (on the beat). */
function earCup(x: Ctx, s: Scene, cx: number, cy: number, side: number, glow: number, rot = 0) {
  const P = s.R, w = P * 0.26, h = P * 0.46;
  x.save();
  x.translate(cx, cy);
  x.rotate(rot);
  x.scale(side, 1); // +x points away from the head
  rr(x, [-w * 0.62, -h * 0.42, w * 0.42, h * 0.84], w * 0.2);
  fillLine(x, s, lin(x, [0, -h / 2, 0, h / 2], [[0, "#4b4558"], [1, "#221f2b"]]), 0.02);
  shadowed(x, s, () => {
    rr(x, [-w * 0.32, -h / 2, w * 0.86, h], w * 0.42);
    fillLine(x, s, lin(x, [0, -h / 2, 0, h / 2], GRAPHITE));
  });
  x.beginPath();
  x.ellipse(w * 0.12, 0, w * 0.3, h * 0.34, 0, 0, Math.PI * 2);
  x.save();
  x.shadowColor = "rgba(255,143,177,0.9)";
  x.shadowBlur = P * 0.25 * glow;
  x.lineWidth = P * 0.045;
  x.strokeStyle = glow > 0.05 ? `rgba(255,${143 + 60 * glow},${177 + 40 * glow},1)` : "#d98aa6";
  x.stroke();
  x.restore();
  x.fillStyle = lin(x, [0, -h * 0.3, 0, h * 0.3], [[0, "#3c3f4b"], [1, "#1c1e25"]]);
  x.fill();
  shine(x, s, [-w * 0.08, -h * 0.34, -w * 0.08, -h * 0.12], 0.45);
  x.restore();
}

interface Phones { cx: number; cy: number; apex: number; glow: number; rot?: number; under?: boolean }

/** Headphones: cups at ±cx, the band arching to `apex` (above the head, or under it when `under`). */
function headphones(x: Ctx, s: Scene, o: Phones) {
  const P = s.R, h = P * 0.46;
  const end = o.under ? o.cy + h * 0.42 : o.cy - h * 0.42;
  x.lineCap = "round";
  for (const [w, style] of [[P * 0.11, lin(x, [0, o.apex, 0, end], GRAPHITE)], [P * 0.035, "rgba(255,255,255,0.28)"]] as const) {
    // An arch: each half bends at its corner, so the top is the apex itself.
    x.beginPath();
    x.moveTo(-o.cx, end);
    x.quadraticCurveTo(-o.cx * 0.96, o.apex, 0, o.apex);
    x.quadraticCurveTo(o.cx * 0.96, o.apex, o.cx, end);
    x.lineWidth = w;
    x.strokeStyle = style;
    x.stroke();
  }
  // The padded strip at the top of the band.
  x.beginPath();
  x.ellipse(0, o.apex + (o.under ? -1 : 1) * P * 0.01, o.cx * 0.32, P * 0.065, 0, 0, Math.PI * 2);
  fillLine(x, s, lin(x, [0, o.apex - P * 0.06, 0, o.apex + P * 0.06], [[0, "#ff9fbd"], [1, "#d9577f"]]), 0.02);
  for (const sd of [-1, 1]) earCup(x, s, sd * o.cx, o.cy, sd, o.glow, sd * (o.rot ?? 0));
}

/** Headphones on the ears, the ring pulsing with the beat. */
function phonesOn(x: Ctx, s: Scene, glow: number) {
  headphones(x, s, { cx: s.rx * 0.98, cy: -s.ry * 0.04, apex: -s.ry * 1.16, glow });
}

/** An eighth note, for the props that sing. */
function noteGlyph(x: Ctx, s: Scene, cx: number, cy: number, k: number, color: string) {
  const P = s.R * k;
  x.save();
  x.translate(cx, cy);
  x.rotate(-0.25);
  x.beginPath();
  x.ellipse(0, 0, P * 0.09, P * 0.065, -0.4, 0, Math.PI * 2);
  x.fillStyle = color;
  x.fill();
  x.fillRect(P * 0.065, -P * 0.32, P * 0.035, P * 0.32);
  x.beginPath();
  x.moveTo(P * 0.1, -P * 0.32);
  x.quadraticCurveTo(P * 0.24, -P * 0.24, P * 0.18, -P * 0.1);
  x.lineWidth = P * 0.04;
  x.strokeStyle = color;
  x.stroke();
  x.restore();
}

/** A vinyl record seen from the front, its label turning. */
function vinyl(x: Ctx, s: Scene, cx: number, cy: number, r: number, spin: number) {
  x.save();
  x.translate(cx, cy);
  shadowed(x, s, () => {
    x.beginPath();
    x.arc(0, 0, r, 0, Math.PI * 2);
    x.fillStyle = rad(x, [-r * 0.2, -r * 0.2, r * 0.1, r * 1.1], [[0, "#3a3646"], [1, "#0d0c12"]]);
    x.fill();
  });
  x.strokeStyle = "rgba(255,255,255,0.08)";
  x.lineWidth = Math.max(0.6, r * 0.02);
  for (const k of [0.82, 0.68, 0.56]) {
    x.beginPath();
    x.arc(0, 0, r * k, 0, Math.PI * 2);
    x.stroke();
  }
  // The gloss turns with the record.
  x.rotate(spin);
  x.beginPath();
  x.arc(0, 0, r * 0.9, -0.5, 0.35);
  x.strokeStyle = "rgba(255,255,255,0.35)";
  x.lineWidth = r * 0.07;
  x.stroke();
  x.beginPath();
  x.arc(0, 0, r * 0.36, 0, Math.PI * 2);
  x.fillStyle = lin(x, [-r * 0.36, 0, r * 0.36, 0], PINK);
  x.fill();
  x.fillStyle = "rgba(255,255,255,0.85)";
  x.fillRect(-r * 0.2, -r * 0.13, r * 0.4, r * 0.06);
  x.beginPath();
  x.arc(0, 0, r * 0.06, 0, Math.PI * 2);
  x.fillStyle = "#17151f";
  x.fill();
  x.restore();
}

/** A cassette face: shell, label, two reels turning by `spin`. */
function cassette(x: Ctx, s: Scene, w: number, h: number, spin: number, side: string) {
  const P = s.R;
  shadowed(x, s, () => {
    rr(x, [-w / 2, -h / 2, w, h], P * 0.06);
    fillLine(x, s, lin(x, [0, -h / 2, 0, h / 2], [[0, "#3d3850"], [1, "#221f2d"]]));
  });
  rr(x, [-w * 0.42, -h * 0.4, w * 0.84, h * 0.5], P * 0.04);
  x.fillStyle = lin(x, [0, -h * 0.4, 0, h * 0.1], CREAM);
  x.fill();
  x.fillStyle = "#ff8fb1";
  x.fillRect(-w * 0.42, -h * 0.4, w * 0.84, h * 0.09);
  x.font = `800 ${P * 0.11}px "Segoe UI", system-ui, sans-serif`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillStyle = "#5b3f5c";
  x.fillText(`MIX ${side}`, 0, -h * 0.2);
  rr(x, [-w * 0.27, -h * 0.02, w * 0.54, h * 0.2], P * 0.05);
  x.fillStyle = "#17151f";
  x.fill();
  for (const sd of [-1, 1]) {
    const cx = sd * w * 0.17, cy = h * 0.08;
    x.beginPath();
    x.arc(cx, cy, P * 0.055, 0, Math.PI * 2);
    x.fillStyle = "#ece9f5";
    x.fill();
    x.strokeStyle = "#17151f";
    x.lineWidth = P * 0.018;
    for (let i = 0; i < 3; i++) {
      const a = spin + (i * Math.PI * 2) / 3;
      x.beginPath();
      x.moveTo(cx, cy);
      x.lineTo(cx + Math.cos(a) * P * 0.045, cy + Math.sin(a) * P * 0.045);
      x.stroke();
    }
  }
  shine(x, s, [-w * 0.45, -h * 0.42, -w * 0.3, -h * 0.42], 0.4);
}

/** A turntable deck low in front of the body; returns the platter centre. */
function deck(x: Ctx, s: Scene, spin: number, armDown: number): [number, number] {
  const P = s.R, w = P * 1.36, h = P * 0.34;
  shadowed(x, s, () => {
    rr(x, [-w / 2, -h / 2, w, h], P * 0.08);
    fillLine(x, s, lin(x, [0, -h / 2, 0, h / 2], [[0, "#4a4560"], [1, "#24212e"]]));
  });
  rr(x, [-w / 2 + P * 0.03, h * 0.18, w - P * 0.06, h * 0.22], P * 0.04);
  x.fillStyle = "rgba(0,0,0,0.25)";
  x.fill();
  const px = -P * 0.24, py = -h * 0.1;
  x.save();
  x.translate(px, py);
  x.scale(1, 0.5); // the platter, seen at an angle
  vinyl(x, s, 0, 0, P * 0.32, spin);
  x.restore();
  // Tonearm: pivot on the right, the needle on the record when down.
  const ax = P * 0.28, ay = -h * 0.24;
  const ang = lerp(-0.25, 0.55, armDown);
  x.beginPath();
  x.arc(ax, ay, P * 0.05, 0, Math.PI * 2);
  fillLine(x, s, lin(x, [ax - P * 0.05, 0, ax + P * 0.05, 0], CHROME), 0.02);
  x.save();
  x.translate(ax, ay);
  x.rotate(Math.PI - ang);
  rr(x, [0, -P * 0.015, P * 0.3, P * 0.03], P * 0.015);
  x.fillStyle = lin(x, [0, -P * 0.02, 0, P * 0.02], CHROME);
  x.fill();
  rr(x, [P * 0.27, -P * 0.03, P * 0.07, P * 0.06], P * 0.015);
  x.fillStyle = "#ff8fb1";
  x.fill();
  x.restore();
  return [px, py];
}

/** Flat sound ripples on the floor around a point (k = 0…1 grows them). */
function ripples(x: Ctx, s: Scene, cx: number, cy: number, k: number, color = "255,143,177") {
  for (let i = 0; i < 3; i++) {
    const p = clamp01(k * 1.4 - i * 0.2);
    if (p <= 0 || p >= 1) continue;
    x.beginPath();
    x.ellipse(cx, cy, s.R * (0.25 + 0.5 * p), s.R * (0.06 + 0.1 * p), 0, 0, Math.PI * 2);
    x.strokeStyle = `rgba(${color},${0.8 * (1 - p)})`;
    x.lineWidth = s.R * 0.035;
    x.stroke();
  }
}

// ── 1 · playing ───────────────────────────────────────────────────────────────

/** 1A Bop: HD headphones, the rings lighting on the beat, sound arcs beside the cups. */
export function bopPhones(x: Ctx, s: Scene) {
  const b = onBeat(s.t);
  phonesOn(x, s, 0.35 + 0.65 * b);
  const cy = -s.ry * 0.04;
  for (const sd of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const k = saw(s.t, BEAT, -i * 0.25);
      const d = s.rx * (0.19 + 0.08 * i + 0.05 * k), cx = sd * s.rx * 0.98;
      x.beginPath();
      x.moveTo(cx + sd * d * 0.88, cy - d * 0.48);
      x.quadraticCurveTo(cx + sd * d * 1.12, cy, cx + sd * d * 0.88, cy + d * 0.48);
      x.strokeStyle = `rgba(255,255,255,${0.6 * (1 - k)})`;
      x.lineWidth = s.R * 0.035;
      x.lineCap = "round";
      x.stroke();
    }
  }
}

/** 1B DJ: decks in front, one hand scratching the record, one on the fader. */
export function djDeck(x: Ctx, s: Scene) {
  const { R, ry, t } = s;
  phonesOn(x, s, 0.3 + 0.7 * onBeat(t));
  x.save();
  x.translate(0, ry * 1.0);
  const scratch = Math.sin((2 * Math.PI * t) / BEAT);
  const [px, py] = deck(x, s, t * 5 + scratch * 0.8, 1);
  // Fader and two knobs with LEDs on the beat.
  rr(x, [R * 0.12, R * 0.02, R * 0.32, R * 0.05], R * 0.025);
  x.fillStyle = "#17151f";
  x.fill();
  const fx = R * (0.2 + 0.16 * wave(t, BEAT * 2));
  hand(x, s, fx, R * 0.03, 0.13);
  for (const [i, kx] of [0.42, 0.5].entries()) {
    x.beginPath();
    x.arc(R * kx, -R * 0.08, R * 0.03, 0, Math.PI * 2);
    x.fillStyle = onBeat(t + i * BEAT * 0.5) > 0.5 ? "#9ff0c0" : "#3a3646";
    x.fill();
  }
  hand(x, s, px + scratch * R * 0.08, py - R * 0.02, 0.14);
  x.restore();
}

/** 1C Boombox: held low, the speaker cones thumping, the EQ bars jumping. */
export function boombox(x: Ctx, s: Scene) {
  const { R, ry, t } = s;
  const w = R * 1.15, h = R * 0.5, b = onBeat(t);
  x.save();
  x.translate(0, ry * 1.05);
  rr(x, [-R * 0.33, -h / 2 - R * 0.13, R * 0.66, R * 0.16], R * 0.07);
  x.lineWidth = R * 0.05;
  x.strokeStyle = lin(x, [-R * 0.3, 0, R * 0.3, 0], CHROME);
  x.stroke();
  x.beginPath();
  x.moveTo(R * 0.47, -h / 2);
  x.lineTo(R * 0.8, -h / 2 - R * 0.36);
  x.lineWidth = R * 0.025;
  x.strokeStyle = "#c9ccd6";
  x.stroke();
  shadowed(x, s, () => {
    rr(x, [-w / 2, -h / 2, w, h], R * 0.1);
    fillLine(x, s, lin(x, [0, -h / 2, 0, h / 2], [[0, "#ffd6e2"], [1, "#f29bb7"]]));
  });
  for (const sd of [-1, 1]) {
    const cx = sd * w * 0.3, k = 1 + 0.12 * b;
    x.beginPath();
    x.arc(cx, R * 0.02, R * 0.17, 0, Math.PI * 2);
    fillLine(x, s, lin(x, [cx - R * 0.17, 0, cx + R * 0.17, 0], CHROME), 0.02);
    x.beginPath();
    x.arc(cx, R * 0.02, R * 0.12 * k, 0, Math.PI * 2);
    x.fillStyle = rad(x, [cx, R * 0.02, 0, R * 0.13 * k], [[0, "#4a4560"], [0.6, "#24212e"], [1, "#3a3646"]]);
    x.fill();
    x.beginPath();
    x.arc(cx, R * 0.02, R * 0.04 * k, 0, Math.PI * 2);
    x.fillStyle = "#6a6f80";
    x.fill();
  }
  rr(x, [-R * 0.14, -h * 0.32, R * 0.28, h * 0.5], R * 0.03);
  x.fillStyle = "#24212e";
  x.fill();
  for (let i = 0; i < 5; i++) {
    const lv = 0.25 + 0.75 * wave(t, BEAT, i * 0.21) * (0.6 + 0.4 * b);
    x.fillStyle = i % 2 ? "#ffe08a" : "#9ff0c0";
    x.fillRect(-R * 0.11 + i * R * 0.05, h * 0.12 - lv * h * 0.38, R * 0.03, lv * h * 0.38);
  }
  shine(x, s, [-w * 0.42, -h * 0.3, -w * 0.2, -h * 0.3], 0.55);
  hand(x, s, -w / 2 - R * 0.02, R * 0.02, 0.15);
  hand(x, s, w / 2 + R * 0.02, R * 0.02, 0.15);
  x.restore();
}

// ── 2 · singing ───────────────────────────────────────────────────────────────

/** A ball mic head with its mesh, pointing at `ang`. */
function micHead(x: Ctx, s: Scene, r: number) {
  x.beginPath();
  x.arc(0, 0, r, 0, Math.PI * 2);
  fillLine(x, s, rad(x, [-r * 0.35, -r * 0.4, r * 0.1, r * 1.2], [[0, "#c9ccd6"], [0.55, "#6e7380"], [1, "#2f323c"]]), 0.02);
  x.strokeStyle = "rgba(20,22,28,0.45)";
  x.lineWidth = Math.max(0.5, r * 0.06);
  for (let i = -2; i <= 2; i++) {
    const o = i * r * 0.32, c = Math.sqrt(r * r * 0.8 - o * o); // a chord of the ball
    x.beginPath();
    x.moveTo(o, -c);
    x.lineTo(o, c);
    x.moveTo(-c, o);
    x.lineTo(c, o);
    x.stroke();
  }
  shine(x, s, [-r * 0.45, -r * 0.3, -r * 0.2, -r * 0.55], 0.8);
}

/** 2A Karaoke: a pink handheld mic held up to the mouth, its cord trailing down. */
export function karaokeMic(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  const hx = rx * 0.7, hy = ry * 1.04 + Math.sin(t * 2.4) * R * 0.01;
  const mx = rx * 0.34, my = ry * 0.8;
  x.beginPath();
  x.moveTo(hx + R * 0.05, hy + R * 0.12);
  x.bezierCurveTo(hx + R * 0.3, hy + R * 0.35, hx - R * 0.1, hy + R * 0.42, hx + R * 0.15, ry * 1.62);
  x.lineWidth = R * 0.03;
  x.strokeStyle = "#3a3646";
  x.stroke();
  x.save();
  x.translate(hx, hy);
  x.rotate(Math.atan2(my - hy, mx - hx) + Math.PI / 2);
  const len = Math.hypot(mx - hx, my - hy);
  shadowed(x, s, () => {
    x.beginPath();
    x.moveTo(-R * 0.06, R * 0.16);
    x.lineTo(R * 0.06, R * 0.16);
    x.lineTo(R * 0.09, -len + R * 0.14);
    x.lineTo(-R * 0.09, -len + R * 0.14);
    x.closePath();
    fillLine(x, s, lin(x, [-R * 0.08, 0, R * 0.08, 0], PINK));
  });
  rr(x, [-R * 0.105, -len + R * 0.07, R * 0.21, R * 0.08], R * 0.03);
  x.fillStyle = lin(x, [-R * 0.09, 0, R * 0.09, 0], [[0, "#fff1a8"], [0.5, "#ffd15c"], [1, "#d9951c"]]);
  x.fill();
  x.translate(0, -len);
  micHead(x, s, R * 0.14);
  x.restore();
  hand(x, s, hx, hy, 0.15);
}

/** 2B Crooner: a chrome capsule mic on a stand, both hands on it. */
export function standMic(x: Ctx, s: Scene) {
  const { R, ry } = s;
  const my = ry * 0.62, w = R * 0.24, h = R * 0.38;
  x.beginPath();
  x.moveTo(0, my + h / 2);
  x.lineTo(0, ry * 1.62);
  x.lineWidth = R * 0.045;
  x.strokeStyle = lin(x, [-R * 0.03, 0, R * 0.03, 0], CHROME);
  x.stroke();
  x.beginPath();
  x.ellipse(0, ry * 1.64, R * 0.24, R * 0.055, 0, 0, Math.PI * 2);
  fillLine(x, s, lin(x, [0, ry * 1.6, 0, ry * 1.7], GRAPHITE), 0.02);
  shadowed(x, s, () => {
    rr(x, [-w / 2, my - h / 2, w, h], w * 0.5);
    fillLine(x, s, lin(x, [-w / 2, 0, w / 2, 0], CHROME));
  });
  x.strokeStyle = "rgba(60,64,76,0.45)";
  x.lineWidth = R * 0.016;
  for (let i = 1; i < 8; i++) {
    const y = my - h / 2 + (h * i) / 8;
    x.beginPath();
    x.moveTo(-w * 0.42, y);
    x.lineTo(w * 0.42, y);
    x.stroke();
  }
  rr(x, [-w * 0.55, my - R * 0.02, w * 1.1, R * 0.05], R * 0.02);
  x.fillStyle = "#ff8fb1";
  x.fill();
  shine(x, s, [-w * 0.25, my - h * 0.36, -w * 0.25, my + h * 0.2], 0.75);
  hand(x, s, -w * 0.62, my + h * 0.12, 0.14);
  hand(x, s, R * 0.04, my + h * 0.95, 0.14);
}

/** 2C Diva: a pink hairbrush for a mic, the free hand thrown up, sparkles. */
export function hairbrush(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  const hx = rx * 0.9, hy = ry * 0.98, bx = rx * 0.6, by = ry * 0.68;
  x.save();
  x.translate(hx, hy);
  x.rotate(Math.atan2(by - hy, bx - hx) + Math.PI / 2);
  const len = Math.hypot(bx - hx, by - hy);
  shadowed(x, s, () => {
    rr(x, [-R * 0.05, -len + R * 0.1, R * 0.1, len], R * 0.05);
    fillLine(x, s, lin(x, [-R * 0.05, 0, R * 0.05, 0], PINK));
    x.beginPath();
    x.ellipse(0, -len, R * 0.12, R * 0.15, 0, 0, Math.PI * 2);
    fillLine(x, s, lin(x, [-R * 0.12, 0, R * 0.12, 0], PINK));
  });
  x.beginPath();
  x.ellipse(0, -len, R * 0.09, R * 0.115, 0, 0, Math.PI * 2);
  x.fillStyle = "#f7f1fb";
  x.fill();
  x.fillStyle = "#c9b4ff";
  for (let i = 0; i < 9; i++) {
    x.beginPath();
    x.arc(((i % 3) - 1) * R * 0.05, -len + (Math.floor(i / 3) - 1) * R * 0.06, R * 0.014, 0, Math.PI * 2);
    x.fill();
  }
  x.restore();
  hand(x, s, hx, hy, 0.15);
  // The free hand up in the air, swaying with the line.
  const sway = Math.sin((2 * Math.PI * t) / (BEAT * 2));
  hand(x, s, -rx * 1.18 + sway * R * 0.04, -ry * 0.3 + sway * R * 0.05, 0.15);
  for (let i = 0; i < 3; i++) {
    const k = wave(t, 1.3, i * 0.33);
    x.save();
    x.translate(-rx * (0.8 + 0.18 * i), -ry * (0.78 + 0.3 * (i % 2)));
    x.rotate(k);
    x.beginPath();
    for (let j = 0; j < 8; j++) {
      const d = j % 2 === 0 ? R * (0.05 + 0.05 * k) : R * 0.015;
      x.lineTo(Math.cos((j * Math.PI) / 4) * d, Math.sin((j * Math.PI) / 4) * d);
    }
    x.closePath();
    x.fillStyle = `rgba(255,236,150,${0.4 + 0.6 * k})`;
    x.fill();
    x.restore();
  }
}

// ── 3 · paused ────────────────────────────────────────────────────────────────

/** 3A Waiting: headphones down round the neck, a ⏸ bubble above. */
export function neckPhones(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  headphones(x, s, { cx: rx * 0.78, cy: ry * 0.66, apex: ry * 1.32, glow: 0, rot: 0.35, under: true });
  const k = saw(t, 3);
  const pop = k < 0.1 ? (k / 0.1) * 1.1 : k < 0.16 ? 1.1 - ((k - 0.1) / 0.06) * 0.1 : 1;
  const w = R * 0.56, h = R * 0.44;
  x.save();
  x.translate(rx * 0.74, -ry * 1.3 + Math.sin(t * 1.3) * R * 0.03);
  x.scale(pop, pop);
  shadowed(x, s, () => {
    rr(x, [-w / 2, -h / 2, w, h], R * 0.16);
    fillLine(x, s, lin(x, [0, -h / 2, 0, h / 2], [[0, "#ffffff"], [1, "#f3e9fb"]]));
    x.beginPath();
    x.moveTo(-w * 0.28, h / 2 - R * 0.01);
    x.lineTo(-w * 0.42, h / 2 + R * 0.16);
    x.lineTo(-w * 0.08, h / 2 - R * 0.01);
    x.closePath();
    fillLine(x, s, "#f6eefc", 0.02);
  });
  for (const sd of [-1, 1]) {
    rr(x, [sd * R * 0.07 - R * 0.04, -h * 0.26, R * 0.08, h * 0.52], R * 0.03);
    x.fillStyle = lin(x, [0, -h * 0.26, 0, h * 0.26], PINK);
    x.fill();
  }
  x.restore();
}

/** 3B Mixtape: a cassette held in both hands, reels still, looking it over. */
export function heldCassette(x: Ctx, s: Scene) {
  const { R, ry, t } = s;
  const w = R * 0.86, h = R * 0.54;
  x.save();
  x.translate(0, ry * 1.0);
  x.rotate(Math.sin(t * 0.9) * 0.06);
  cassette(x, s, w, h, 0.3, "A");
  hand(x, s, -w / 2 - R * 0.01, R * 0.05, 0.14);
  hand(x, s, w / 2 + R * 0.01, R * 0.05, 0.14);
  x.restore();
}

/** 3C Dozing: headphones still on, slipped a little, a stream of Zs. */
export function dozingPhones(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  headphones(x, s, { cx: rx * 0.98, cy: 0, apex: -ry * 1.12, glow: 0, rot: 0.08 });
  for (let i = 0; i < 3; i++) {
    const k = saw(t, 2.8, i / 3);
    x.save();
    x.translate(rx * (0.75 + 0.4 * k), -ry * (1.05 + 1.1 * k));
    x.rotate(-0.2);
    x.globalAlpha *= Math.sin(k * Math.PI);
    x.font = `900 ${R * (0.18 + 0.12 * k)}px "Segoe UI", system-ui, sans-serif`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.lineWidth = R * 0.03;
    x.strokeStyle = "#8f7bd9";
    x.strokeText("z", 0, 0);
    x.fillStyle = "#e8e1fb";
    x.fillText("z", 0, 0);
    x.restore();
  }
}

// ── 4 · track change (one-shots, t = the act's age) ───────────────────────────

/** 4A Vinyl swap: the old record sinks away, the new one drops in spinning and is caught. */
export function vinylSwap(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  const cx = rx * 0.95, cy = ry * 0.95, r = R * 0.27;
  const out = ease(t / 0.5);
  if (out < 1) {
    x.save();
    x.globalAlpha *= 1 - out;
    x.translate(cx, cy + out * R * 0.3);
    x.scale(1 - 0.4 * out, 1 - 0.4 * out);
    vinyl(x, s, 0, 0, r, t * 3);
    x.restore();
  }
  const fall = ease((t - 0.25) / 0.65);
  if (t > 0.25) vinyl(x, s, cx, lerp(-ry * 2.4, cy, fall), r, t * 9);
  if (t > 0.85) hand(x, s, cx - r * 0.9, cy + r * 0.5, 0.15);
}

/** 4B Tape flip: the cassette turns over from side A to side B. */
export function tapeFlip(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  const w = R * 0.86, h = R * 0.54;
  const k = ease((t - 0.35) / 0.7);
  x.save();
  x.translate(0, ry * 1.0 - Math.sin(k * Math.PI) * R * 0.12);
  x.scale(1, Math.cos(k * Math.PI));
  cassette(x, s, w, h, t * 4, k < 0.5 ? "A" : "B");
  x.restore();
  hand(x, s, -w / 2 - R * 0.01, ry * 1.0, 0.14);
  hand(x, s, w / 2 + R * 0.01, ry * 1.0, 0.14);
  // A turning arrow beside it while it flips.
  if (k > 0 && k < 1) {
    x.beginPath();
    x.arc(rx * 1.12, ry * 0.7, R * 0.16, -Math.PI * 0.2, Math.PI * (0.2 + 1.2 * k));
    x.lineWidth = R * 0.05;
    x.lineCap = "round";
    x.strokeStyle = `rgba(255,143,177,${Math.sin(k * Math.PI)})`;
    x.stroke();
  }
}

/** 4C Skip: a hand swipes across, a ⏭ flies off to the right. */
export function skipSwipe(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  const sw = ease((t - 0.1) / 0.45);
  const hx = lerp(-rx * 0.95, rx * 0.95, sw), hy = ry * 0.72;
  if (t > 0.1 && t < 0.75) {
    for (let i = 0; i < 3; i++) {
      x.beginPath();
      x.moveTo(hx - R * (0.2 + 0.12 * i), hy + (i - 1) * R * 0.07);
      x.lineTo(hx - R * (0.45 + 0.2 * i), hy + (i - 1) * R * 0.07);
      x.lineWidth = R * 0.03;
      x.lineCap = "round";
      x.strokeStyle = `rgba(255,255,255,${0.7 * (1 - sw * 0.6)})`;
      x.stroke();
    }
    hand(x, s, hx, hy, 0.15);
  }
  const fly = ease((t - 0.45) / 0.8);
  if (t > 0.45) {
    x.save();
    x.translate(rx * (1.0 + 0.18 * fly), lerp(ry * 0.1, -ry * 0.75, fly));
    x.globalAlpha *= 1 - fly * 0.85;
    const k = R * 0.13;
    shadowed(x, s, () => {
      x.beginPath();
      for (const ox of [-k * 1.1, 0]) {
        x.moveTo(ox - k * 0.5, -k);
        x.lineTo(ox + k * 0.7, 0);
        x.lineTo(ox - k * 0.5, k);
        x.closePath();
      }
      fillLine(x, s, lin(x, [0, -k, 0, k], PINK), 0.02);
    });
    rr(x, [k * 0.75, -k, k * 0.28, k * 2], k * 0.12);
    fillLine(x, s, "#ff8fb1", 0.02);
    x.restore();
  }
}

// ── 5 · resume (one-shots) ────────────────────────────────────────────────────

/** 5A Needle drop: the tonearm comes down on the record, sound ripples out. */
export function needleDrop(x: Ctx, s: Scene) {
  const { ry, t } = s;
  x.save();
  x.translate(0, ry * 1.0);
  const down = ease((t - 0.1) / 0.45);
  const [px, py] = deck(x, s, t > 0.55 ? (t - 0.55) * 6 : 0, down);
  ripples(x, s, px, py, clamp01((t - 0.55) / 0.9));
  x.restore();
}

/** 5B Play: a big round play button, pressed by a hand, a ripple on the press. */
export function playButton(x: Ctx, s: Scene) {
  const { R, ry, t } = s;
  const press = Math.exp(-(((t - 0.45) / 0.08) ** 2));
  const r = R * 0.24, depth = R * 0.07 * (1 - 0.7 * press);
  x.save();
  x.translate(0, ry * 1.02);
  ripples(x, s, 0, R * 0.06, clamp01((t - 0.45) / 0.9));
  x.beginPath();
  x.ellipse(0, depth * 0.5 + R * 0.04, r * 1.08, r * 0.42, 0, 0, Math.PI * 2);
  x.fillStyle = "#b84a6c";
  x.fill();
  shadowed(x, s, () => {
    x.beginPath();
    x.ellipse(0, -depth + R * 0.04, r, r * 0.4, 0, 0, Math.PI * 2);
    fillLine(x, s, rad(x, [-r * 0.3, -depth - r * 0.2, r * 0.1, r * 1.2], [[0, "#ffd0de"], [0.55, "#ff8fb1"], [1, "#d9577f"]]));
  });
  x.beginPath();
  x.moveTo(-r * 0.22, -depth + R * 0.04 - r * 0.16);
  x.lineTo(r * 0.3, -depth + R * 0.04);
  x.lineTo(-r * 0.22, -depth + R * 0.04 + r * 0.16);
  x.closePath();
  x.fillStyle = "#ffffff";
  x.fill();
  // The hand comes down onto it, then lifts away.
  const reach = t < 0.45 ? ease(t / 0.45) : 1 - ease((t - 0.55) / 0.4);
  if (reach > 0.02) hand(x, s, r * 0.55, lerp(-R * 0.2, -depth - R * 0.02, reach), 0.15);
  x.restore();
}

/** 5C Phones on: the headphones come down from above onto the ears, click, glow. */
export function phonesPutOn(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  const k = ease((t - 0.05) / 0.55);
  const cy = lerp(-ry * 1.5, -ry * 0.04, k);
  const cx = lerp(rx * 0.9, rx * 0.98, k);
  const click = Math.exp(-(((t - 0.65) / 0.1) ** 2));
  headphones(x, s, { cx, cy, apex: cy - ry * 1.12, glow: t > 0.62 ? 0.4 + 0.6 * click : 0 });
  if (t < 0.7) for (const sd of [-1, 1]) hand(x, s, sd * (cx + R * 0.2), cy + R * 0.08, 0.15);
  if (click > 0.05) {
    for (const sd of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const a = (sd > 0 ? 0 : Math.PI) + (i - 1) * 0.6;
        const r0 = R * 0.3, r1 = R * (0.3 + 0.15 * click);
        x.beginPath();
        x.moveTo(sd * cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        x.lineTo(sd * cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        x.lineWidth = R * 0.035;
        x.strokeStyle = `rgba(255,224,138,${click})`;
        x.stroke();
      }
    }
  }
  if (t > 0.7) noteGlyph(x, s, rx * 1.15, lerp(-ry * 0.5, -ry * 1.4, ease((t - 0.7) / 0.8)), 1, `rgba(255,143,177,${1 - ease((t - 1.1) / 0.5)})`);
}

// ── Which prop for which act ──────────────────────────────────────────────────

type Prop = (x: Ctx, s: Scene) => void;

/** `${act name}:${variant}` → its props. */
export const MUSIC_PROPS: Record<string, Prop[]> = {
  "music:1A": [bopPhones],
  "music:1B": [djDeck],
  "music:1C": [boombox],
  "music:2A": [karaokeMic],
  "music:2B": [standMic],
  "music:2C": [hairbrush],
  "music:3A": [neckPhones],
  "music:3B": [heldCassette],
  "music:3C": [dozingPhones],
  "musicCue:4A": [phonesOnStill, vinylSwap],
  "musicCue:4B": [tapeFlip],
  "musicCue:4C": [phonesOnStill, skipSwipe],
  "musicCue:5A": [needleDrop],
  "musicCue:5B": [playButton],
  "musicCue:5C": [phonesPutOn],
};

/** Headphones on, softly lit: worn through the cues that keep listening. */
function phonesOnStill(x: Ctx, s: Scene) {
  phonesOn(x, s, 0.4);
}

/** Draws the act's props; an unknown variant draws nothing. */
export function drawMusicProp(x: Ctx, s: Scene, name: string, variant: string | null) {
  for (const draw of MUSIC_PROPS[`${name}:${variant ?? ""}`] ?? []) draw(x, s);
}
