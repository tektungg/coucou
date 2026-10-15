// Music acts (acts.ts "music" and "musicCue"): HD props for the Music pill,
// drawn in code in the claudeProps.ts style (gradients, soft outline, shadow,
// gloss, Mochi's own hands). Playing: headphones lighting on the beat. Singing:
// a karaoke mic. Paused: headphones round the neck and a pause bubble. Track
// change: a vinyl swap. Resume: the headphones go back on. Picked from fifteen
// designs (commit 0e9a775); dev/music-acts-preview.html shows them, and
// tests/musicProps.test.ts keeps every prop inside the island's bot canvas
// and off the eyes.
//
// Body space, origin at Mochi's centre, +y down. `rx`/`ry` place things on the
// body, `s.R` (R × PROP_SCALE) sizes them. The eyes sit at |x| 0.26–0.57 R,
// y −0.06–0.27 R: props stay below or beside that box, or above the head.

import { BEAT } from "./acts.ts";
import { fillLine, hand, lin, rad, rr, saw, shadowed, shine, type Ctx, type Scene } from "./claudeProps.ts";

const PINK: [number, string][] = [[0, "#ffc2d6"], [0.5, "#ff8fb1"], [1, "#d9577f"]];
const GRAPHITE: [number, string][] = [[0, "#6a6f80"], [1, "#2a2d36"]];

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

// ── Playing ───────────────────────────────────────────────────────────────

/** Playing: HD headphones, the rings lighting on the beat, sound arcs beside the cups. */
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

// ── Singing ───────────────────────────────────────────────────────────────

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

/** Singing: a pink handheld mic held up to the mouth, its cord trailing down. */
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

// ── Paused ────────────────────────────────────────────────────────────────

/** Paused: headphones down round the neck, a ⏸ bubble above. */
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

// ── Track change (one-shot, t = the act's age) ───────────────────────────

/** Track change: the old record sinks away, the new one drops in spinning and is caught. */
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

// ── Resume (one-shot) ────────────────────────────────────────────────────

/** Resume: the headphones come down from above onto the ears, click, glow. */
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
  "music:playing": [bopPhones],
  "music:singing": [karaokeMic],
  "music:paused": [neckPhones],
  "musicCue:change": [phonesOnStill, vinylSwap],
  "musicCue:resume": [phonesPutOn],
};

/** Headphones on, softly lit: worn through the cues that keep listening. */
function phonesOnStill(x: Ctx, s: Scene) {
  phonesOn(x, s, 0.4);
}

/** Draws the act's props; an unknown variant draws nothing. */
export function drawMusicProp(x: Ctx, s: Scene, name: string, variant: string | null) {
  for (const draw of MUSIC_PROPS[`${name}:${variant ?? ""}`] ?? []) draw(x, s);
}
