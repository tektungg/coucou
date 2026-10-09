// Claude Code acts (acts.ts "claude" and "claudeEnd"): one prop per session
// state, drawn in code like every other act; dev/claude-acts-preview.html shows
// each one on the real Mochi, at preview size and at island size.
//
// Body space, sizes in R. Everything stays inside the island's
// bot canvas (about ±1.6 R wide) and clear of the eyes; tests/claudeProps.test.ts
// replays every prop against both limits.

// ── Drawing helpers ───────────────────────────────────────────────────────────
// Body space: origin at Mochi's centre, sizes in R. No imports, so node --test
// can load this file (tests/claudeProps.test.ts).

export type Ctx = CanvasRenderingContext2D;

export interface Scene {
  R: number;
  rx: number;
  ry: number;
  /** Seconds: the act's age for a one-shot, the engine's free clock otherwise. */
  t: number;
}

export const OUTLINE = "rgba(30,18,40,0.32)";

/** x, y, width, height. */
type Rect = [number, number, number, number];
/** Two points: x0, y0, x1, y1. */
type Seg = [number, number, number, number];

export function rr(x: Ctx, [X, Y, W, H]: Rect, r: number) {
  // arcTo throws on a negative radius, which would stop every card's animation.
  const k = Math.max(0, Math.min(r, Math.abs(W) / 2, Math.abs(H) / 2));
  x.beginPath();
  x.moveTo(X + k, Y);
  x.arcTo(X + W, Y, X + W, Y + H, k);
  x.arcTo(X + W, Y + H, X, Y + H, k);
  x.arcTo(X, Y + H, X, Y, k);
  x.arcTo(X, Y, X + W, Y, k);
  x.closePath();
}

export function lin(x: Ctx, [x0, y0, x1, y1]: Seg, stops: [number, string][]): CanvasGradient {
  const g = x.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

/** Centre x, y, then the inner and outer radius. */
export function rad(x: Ctx, [cx, cy, r0, r1]: Seg, stops: [number, string][]): CanvasGradient {
  const g = x.createRadialGradient(cx, cy, r0, cx, cy, r1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

/** Fills the current path, then strokes it with the soft dark outline. */
export function fillLine(x: Ctx, s: Scene, fill: string | CanvasGradient, width = 0.03) {
  x.fillStyle = fill;
  x.fill();
  x.strokeStyle = OUTLINE;
  x.lineWidth = Math.max(0.8, s.R * width);
  x.stroke();
}

/** A soft drop shadow for whatever `draw` paints. */
export function shadowed(x: Ctx, s: Scene, draw: () => void, blur = 0.12, dy = 0.05) {
  x.save();
  x.shadowColor = "rgba(0,0,0,0.35)";
  x.shadowBlur = s.R * blur;
  x.shadowOffsetY = s.R * dy;
  draw();
  x.restore();
}

/** One of Mochi's little hands, shaded like the body. */
export function hand(x: Ctx, s: Scene, cx: number, cy: number, r = 0.17) {
  const k = s.R * r;
  x.beginPath();
  x.arc(cx, cy, k, 0, Math.PI * 2);
  fillLine(x, s, rad(x, [cx - k * 0.35, cy - k * 0.4, k * 0.1, k * 1.2], [[0, "#ffffff"], [1, "#cfd0d6"]]), 0.025);
}

/** Small white shine streak, the gloss every prop carries. */
export function shine(x: Ctx, s: Scene, [x0, y0, x1, y1]: Seg, alpha = 0.6) {
  x.strokeStyle = `rgba(255,255,255,${alpha})`;
  x.lineWidth = s.R * 0.05;
  x.lineCap = "round";
  x.beginPath();
  x.moveTo(x0, y0);
  x.lineTo(x1, y1);
  x.stroke();
}

/** 0 → 1 → 0 over `period` seconds, eased. */
export const wave = (t: number, period: number, phase = 0) => 0.5 - 0.5 * Math.cos(((t / period + phase) % 1) * Math.PI * 2);
/** 0 → 1 sawtooth. */
export const saw = (t: number, period: number, phase = 0) => (((t / period + phase) % 1) + 1) % 1;

/** Props are drawn a size up from Mochi's R, so they still read on a 58 px Mochi. */
export const PROP_SCALE = 1.3;

const GOLD: [number, string][] = [[0, "#fff1a8"], [0.45, "#ffd15c"], [1, "#d9951c"]];
const CONFETTI = ["#ff8fb1", "#ffe08a", "#8fd3ff", "#9ff0c0", "#c9b4ff", "#ffb36b"];

// ── idle: a steaming mug ──────────────────────────────────────────────────────

function steamWisp(x: Ctx, s: Scene, ox: number, top: number, k: number) {
  const { R } = s;
  const y0 = top - R * 0.08 - k * R * 0.55;
  x.strokeStyle = `rgba(255,255,255,${0.75 * Math.sin(k * Math.PI)})`;
  x.lineWidth = R * 0.05;
  x.lineCap = "round";
  x.beginPath();
  x.moveTo(ox, y0 + R * 0.22);
  x.bezierCurveTo(ox + R * 0.09, y0 + R * 0.14, ox - R * 0.09, y0 + R * 0.07, ox + R * 0.02, y0);
  x.stroke();
}

function heartDecal(x: Ctx, size: number, cx: number, cy: number) {
  x.beginPath();
  x.moveTo(cx, cy + size * 0.4);
  x.bezierCurveTo(cx - size * 1.1, cy - size * 0.2, cx - size * 0.5, cy - size, cx, cy - size * 0.4);
  x.bezierCurveTo(cx + size * 0.5, cy - size, cx + size * 1.1, cy - size * 0.2, cx, cy + size * 0.4);
  x.fillStyle = "rgba(255,255,255,0.85)";
  x.fill();
}

export function mug(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  const w = R * 0.44, h = R * 0.48;
  x.save();
  x.translate(rx * 0.9, ry * 0.66 + Math.sin(t * 1.4) * R * 0.015);
  x.rotate(-0.05);
  for (let i = 0; i < 3; i++) steamWisp(x, s, (i - 1) * w * 0.26, -h / 2, saw(t, 2.2, i / 3));
  shadowed(x, s, () => {
    x.beginPath();
    x.ellipse(w / 2, 0, w * 0.32, h * 0.26, 0, -Math.PI / 2, Math.PI / 2);
    x.lineWidth = R * 0.09;
    x.strokeStyle = "#e86e95";
    x.stroke();
    rr(x, [-w / 2, -h / 2, w, h], R * 0.1);
    fillLine(x, s, lin(x, [-w / 2, 0, w / 2, 0], [[0, "#ffb3cb"], [0.55, "#ff8fb1"], [1, "#e0638c"]]));
  });
  x.beginPath();
  x.ellipse(0, -h / 2 + R * 0.02, w * 0.42, R * 0.06, 0, 0, Math.PI * 2);
  x.fillStyle = lin(x, [0, -h / 2 - R * 0.04, 0, -h / 2 + R * 0.08], [[0, "#5a3326"], [1, "#8a5a3c"]]);
  x.fill();
  shine(x, s, [-w * 0.3, -h * 0.25, -w * 0.3, h * 0.2], 0.55);
  heartDecal(x, R * 0.07, w * 0.08, h * 0.08);
  hand(x, s, -w / 2 - R * 0.02, h * 0.12);
  x.restore();
}

// ── thinking: a thought cloud ─────────────────────────────────────────────────

const CLOUD_PUFFS: [number, number, number][] = [[-0.34, 0.06, 0.24], [-0.12, -0.12, 0.3], [0.18, -0.1, 0.28], [0.36, 0.08, 0.22], [0.02, 0.14, 0.26]];

export function thoughtCloud(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  const cx = rx * 0.5, cy = -ry * 1.62;
  x.save();
  x.translate(0, Math.sin(t * 1.3) * R * 0.03);
  for (const [bx, by, br] of [[rx * 0.26, -ry * 1.02, 0.07], [rx * 0.38, -ry * 1.2, 0.1]] as const) {
    x.beginPath();
    x.arc(bx, by, R * br, 0, Math.PI * 2);
    fillLine(x, s, "#ffffff", 0.025);
  }
  shadowed(x, s, () => {
    x.beginPath();
    for (const [dx, dy, r] of CLOUD_PUFFS) {
      x.moveTo(cx + dx * R + r * R, cy + dy * R);
      x.arc(cx + dx * R, cy + dy * R, r * R, 0, Math.PI * 2);
    }
    x.fillStyle = lin(x, [0, cy - R * 0.4, 0, cy + R * 0.4], [[0, "#ffffff"], [1, "#e8e1fb"]]);
    x.fill();
  });
  for (let i = 0; i < 3; i++) {
    const p = wave(t, 1.2, -i * 0.18);
    x.beginPath();
    x.arc(cx + (i - 1) * R * 0.2, cy + R * 0.03, R * (0.055 + 0.025 * p), 0, Math.PI * 2);
    x.fillStyle = `rgba(139,92,246,${0.45 + 0.55 * p})`;
    x.fill();
  }
  x.restore();
}

// ── working: the prop follows the tool ────────────────────────────────────────

/** Edit / Write: a keyboard under the body, keys going down under the hands. */
export function keyboard(x: Ctx, s: Scene) {
  const { R, ry, t } = s;
  const w = R * 1.1, h = R * 0.34;
  x.save();
  x.translate(0, ry * 0.98);
  shadowed(x, s, () => {
    rr(x, [-w / 2, -h / 2, w, h], R * 0.07);
    fillLine(x, s, lin(x, [0, -h / 2, 0, h / 2], [[0, "#4a4560"], [1, "#2b2738"]]));
  });
  const down = Math.floor(t * 9) % 14;
  for (let k = 0; k < 14; k++) {
    const r = Math.floor(k / 7), c = k % 7;
    const pressed = k === down;
    rr(x, [-w / 2 + R * 0.07 + c * R * 0.138, -h / 2 + R * 0.06 + r * R * 0.13 + (pressed ? R * 0.015 : 0), R * 0.11, R * 0.09], R * 0.025);
    x.fillStyle = pressed ? "#8fd3ff" : lin(x, [0, -h / 2, 0, h / 2], [[0, "#e9e6f2"], [1, "#bdb7cc"]]);
    x.fill();
  }
  hand(x, s, -w * 0.24, -h * 0.3 + Math.max(0, Math.sin(t * 18)) * R * 0.05, 0.14);
  hand(x, s, w * 0.24, -h * 0.3 + Math.max(0, -Math.sin(t * 18)) * R * 0.05, 0.14);
  x.restore();
}

function terminalChrome(x: Ctx, s: Scene, w: number, h: number) {
  const { R } = s;
  shadowed(x, s, () => {
    rr(x, [-w / 2, -h / 2, w, h], R * 0.08);
    fillLine(x, s, "#0f0d16");
  });
  rr(x, [-w / 2, -h / 2, w, R * 0.15], R * 0.08);
  x.fillStyle = "#2b2738";
  x.fill();
  ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
    x.beginPath();
    x.arc(-w / 2 + R * (0.1 + i * 0.09), -h / 2 + R * 0.075, R * 0.03, 0, Math.PI * 2);
    x.fillStyle = c;
    x.fill();
  });
}

/** Bash: a terminal floating above, a command being typed. */
export function terminal(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  const w = R * 0.92, h = R * 0.62;
  x.save();
  x.translate(rx * 0.5, -ry * 1.62 + Math.sin(t * 1.2) * R * 0.02);
  x.rotate(0.04);
  terminalChrome(x, s, w, h);
  const cmd = "npm test";
  const typed = cmd.slice(0, Math.floor(saw(t, 3) * (cmd.length + 4)));
  x.font = `700 ${R * 0.15}px Consolas, monospace`;
  x.fillStyle = "#9ff0c0";
  x.fillText("❯", -w / 2 + R * 0.08, -h / 2 + R * 0.36);
  x.fillStyle = "#ece9f5";
  x.fillText(typed, -w / 2 + R * 0.24, -h / 2 + R * 0.36);
  if (Math.floor(t * 2.5) % 2 === 0) x.fillRect(-w / 2 + R * 0.25 + x.measureText(typed).width, -h / 2 + R * 0.24, R * 0.07, R * 0.15);
  x.fillStyle = "rgba(159,240,192,0.55)";
  x.fillRect(-w / 2 + R * 0.08, -h / 2 + R * 0.46, w * 0.5, R * 0.035);
  x.restore();
}

/** Read / Grep / Web: a magnifying glass that scans side to side. */
export function magnifier(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  const sweep = Math.sin(t * 1.6);
  x.save();
  // Low on the right, a short sweep: the lens never crosses the right eye.
  x.translate(rx * 0.95 + sweep * R * 0.06, ry * 0.7 + Math.cos(t * 3.2) * R * 0.02);
  x.rotate(-0.5 + sweep * 0.08);
  rr(x, [-R * 0.05, R * 0.24, R * 0.1, R * 0.42], R * 0.05);
  fillLine(x, s, lin(x, [-R * 0.05, 0, R * 0.05, 0], [[0, "#c98d56"], [1, "#8a5a32"]]));
  shadowed(x, s, () => {
    x.beginPath();
    x.arc(0, 0, R * 0.27, 0, Math.PI * 2);
    x.lineWidth = R * 0.08;
    x.strokeStyle = lin(x, [-R * 0.3, -R * 0.3, R * 0.3, R * 0.3], [[0, "#f3f4f7"], [0.5, "#a3a9b6"], [1, "#6e7380"]]);
    x.stroke();
  });
  x.beginPath();
  x.arc(0, 0, R * 0.23, 0, Math.PI * 2);
  x.fillStyle = rad(x, [-R * 0.06, -R * 0.06, 0, R * 0.25], [[0, "rgba(220,240,255,0.55)"], [1, "rgba(143,211,255,0.25)"]]);
  x.fill();
  shine(x, s, [-R * 0.12, -R * 0.02, -R * 0.03, -R * 0.13], 0.85);
  x.restore();
}

// ── question: a "?" speech bubble ─────────────────────────────────────────────

function bubblePath(x: Ctx, R: number, w: number, h: number) {
  const r = R * 0.14;
  x.beginPath();
  x.moveTo(-w / 2 + r, -h / 2);
  x.arcTo(w / 2, -h / 2, w / 2, h / 2, r);
  x.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
  x.lineTo(-w * 0.12, h / 2);
  x.lineTo(-w * 0.42, h / 2 + R * 0.18);
  x.lineTo(-w * 0.34, h / 2);
  x.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r);
  x.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r);
  x.closePath();
}

export function questionBubble(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  const k = saw(t, 2.6);
  const pop = k < 0.12 ? (k / 0.12) * 1.15 : k < 0.2 ? 1.15 - ((k - 0.12) / 0.08) * 0.15 : 1;
  const w = R * 0.66, h = R * 0.52;
  x.save();
  x.translate(rx * 0.72, -ry * 1.25 + Math.sin(t * 1.4) * R * 0.03);
  x.scale(pop, pop);
  shadowed(x, s, () => {
    bubblePath(x, R, w, h);
    fillLine(x, s, lin(x, [0, -h / 2, 0, h / 2], [[0, "#ffffff"], [1, "#e6f9fc"]]));
  });
  const size = R * 0.4;
  x.font = `900 ${size}px "Segoe UI", system-ui, sans-serif`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.lineWidth = R * 0.04;
  x.strokeStyle = "#0e8fa3";
  x.strokeText("?", 0, R * 0.01);
  x.fillStyle = lin(x, [0, -size / 2, 0, size / 2], [[0, "#5ee6f7"], [1, "#16b8d0"]]);
  x.fillText("?", 0, R * 0.01);
  x.restore();
}

// ── approval: a golden key held up ────────────────────────────────────────────

function sparkle(x: Ctx, s: Scene, cx: number, cy: number, k: number) {
  const r = s.R * (0.06 + 0.08 * k);
  x.save();
  x.translate(cx, cy);
  x.rotate(k * 0.6);
  x.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const d = i % 2 === 0 ? r : r * 0.3;
    x.lineTo(Math.cos(a) * d, Math.sin(a) * d);
  }
  x.closePath();
  x.fillStyle = `rgba(255,236,150,${0.4 + 0.6 * k})`;
  x.fill();
  x.restore();
}

export function goldenKey(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  x.save();
  // Held by the bow, low at the side, the bit pointing up: inside the canvas, off the eyes.
  x.translate(rx * 0.86, ry * 0.5);
  x.rotate(-1.2 + Math.sin(t * 9) * 0.08 * wave(t, 1.6));
  x.scale(1.2, 1.2);
  const gold = lin(x, [-R * 0.3, -R * 0.2, R * 0.4, R * 0.2], GOLD);
  shadowed(x, s, () => {
    // Shaft and teeth first, the bow on top. rr() starts its own path, so each is filled on its own.
    rr(x, [-R * 0.02, -R * 0.045, R * 0.5, R * 0.09], R * 0.03);
    fillLine(x, s, gold, 0.02);
    rr(x, [R * 0.34, 0, R * 0.07, R * 0.15], R * 0.02);
    fillLine(x, s, gold, 0.02);
    rr(x, [R * 0.22, 0, R * 0.06, R * 0.11], R * 0.02);
    fillLine(x, s, gold, 0.02);
    x.beginPath();
    x.arc(-R * 0.16, 0, R * 0.17, 0, Math.PI * 2);
    x.arc(-R * 0.16, 0, R * 0.08, 0, Math.PI * 2, true);
    fillLine(x, s, gold);
  });
  shine(x, s, [-R * 0.27, -R * 0.06, -R * 0.2, -R * 0.13], 0.8);
  x.restore();
  sparkle(x, s, rx * 1.12, -ry * 0.3, wave(t, 1.1));
  hand(x, s, rx * 0.8, ry * 0.62, 0.15);
}

// ── ratelimit: an hourglass ───────────────────────────────────────────────────

function glassPath(x: Ctx, R: number, w: number, h: number) {
  x.beginPath();
  x.moveTo(-w / 2, -h / 2);
  x.bezierCurveTo(-w / 2, -h * 0.1, -R * 0.04, -R * 0.06, -R * 0.03, 0);
  x.bezierCurveTo(-R * 0.04, R * 0.06, -w / 2, h * 0.1, -w / 2, h / 2);
  x.lineTo(w / 2, h / 2);
  x.bezierCurveTo(w / 2, h * 0.1, R * 0.04, R * 0.06, R * 0.03, 0);
  x.bezierCurveTo(R * 0.04, -R * 0.06, w / 2, -h * 0.1, w / 2, -h / 2);
  x.closePath();
}

function sand(x: Ctx, s: Scene, w: number, h: number, fill: number) {
  const { R, t } = s;
  x.save();
  glassPath(x, R, w, h);
  x.clip();
  x.fillStyle = lin(x, [0, -h / 2, 0, h / 2], [[0, "#ffe08a"], [1, "#e9a93a"]]);
  const top = (1 - fill) * h * 0.42;
  x.fillRect(-w / 2, -top, w, top);
  const pile = fill * h * 0.42;
  x.beginPath();
  x.moveTo(-w / 2, h / 2);
  x.lineTo(0, h / 2 - pile - R * 0.06);
  x.lineTo(w / 2, h / 2);
  x.fill();
  if (fill < 1) {
    for (let i = 0; i < 5; i++) x.fillRect(-R * 0.012, saw(t, 0.5, i / 5) * h * 0.45, R * 0.024, R * 0.04);
  }
  x.restore();
}

export function hourglass(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  const k = saw(t, 4.2);
  const flip = k > 0.86 ? (k - 0.86) / 0.14 : 0;
  const w = R * 0.4, h = R * 0.72;
  x.save();
  x.translate(rx * 0.92, ry * 0.4);
  // Turned over towards you (a vertical flip), so it never sweeps sideways into the face.
  x.scale(1, Math.cos(flip * Math.PI));
  glassPath(x, R, w, h);
  x.fillStyle = "rgba(220,235,255,0.22)";
  x.fill();
  sand(x, s, w, h, flip > 0 ? 1 : Math.min(1, k / 0.86));
  glassPath(x, R, w, h);
  x.strokeStyle = "rgba(255,255,255,0.7)";
  x.lineWidth = R * 0.03;
  x.stroke();
  shine(x, s, [-w * 0.32, -h * 0.4, -w * 0.25, -h * 0.18], 0.7);
  for (const y of [-h / 2, h / 2]) {
    rr(x, [-w / 2 - R * 0.05, y - R * 0.05, w + R * 0.1, R * 0.1], R * 0.04);
    fillLine(x, s, lin(x, [0, y - R * 0.05, 0, y + R * 0.05], [[0, "#d9a066"], [1, "#8a5a32"]]), 0.02);
  }
  x.restore();
}

// ── error: smoke puffs, and a plaster that stays ──────────────────────────────

export function smoke(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  for (let i = 0; i < 4; i++) {
    const k = saw(t, 2.2, i / 4);
    const cx = -rx * 0.15 + i * R * 0.14 + Math.sin(k * 6 + i) * R * 0.06;
    const cy = -ry * 0.95 - k * R * 0.75;
    const r = R * (0.1 + k * 0.16);
    x.beginPath();
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.arc(cx + r * 0.7, cy + r * 0.2, r * 0.75, 0, Math.PI * 2);
    x.fillStyle = rad(x, [cx - r * 0.3, cy - r * 0.3, 0, r * 1.4], [[0, `rgba(236,232,245,${0.95 * (1 - k)})`], [1, `rgba(150,143,170,${0.8 * (1 - k)})`]]);
    x.fill();
  }
}

export function plaster(x: Ctx, s: Scene) {
  const { R, rx, ry } = s;
  x.save();
  x.translate(rx * 0.38, -ry * 0.62);
  x.rotate(-0.55);
  rr(x, [-R * 0.24, -R * 0.075, R * 0.48, R * 0.15], R * 0.07);
  fillLine(x, s, lin(x, [0, -R * 0.08, 0, R * 0.08], [[0, "#ffe2c4"], [1, "#f1bf92"]]), 0.02);
  rr(x, [-R * 0.08, -R * 0.075, R * 0.16, R * 0.15], R * 0.02);
  x.fillStyle = "#e9ad7c";
  x.fill();
  x.fillStyle = "rgba(160,100,60,0.5)";
  for (const dx of [-0.17, -0.12, 0.12, 0.17]) {
    x.beginPath();
    x.arc(dx * R, 0, R * 0.012, 0, Math.PI * 2);
    x.fill();
  }
  x.restore();
}

// ── finished: a party popper and confetti ─────────────────────────────────────

function confetti(x: Ctx, s: Scene, mx: number, my: number, k: number) {
  const { R } = s;
  for (let i = 0; i < 22; i++) {
    // Up and to the right only, away from the face.
    const a = -Math.PI * (0.18 + (((i * 47) % 100) / 100) * 0.34);
    const v = R * (1.1 + ((i * 31) % 10) / 10);
    x.save();
    x.translate(mx + Math.cos(a) * v * k, my + Math.sin(a) * v * k + R * 1.6 * k * k);
    x.rotate(k * 12 + i);
    x.globalAlpha *= Math.min(1, (1 - k) * 2.5);
    x.fillStyle = CONFETTI[i % CONFETTI.length];
    if (i % 3 === 0) {
      x.beginPath();
      x.arc(0, 0, R * 0.035, 0, Math.PI * 2);
      x.fill();
    } else x.fillRect(-R * 0.025, -R * 0.05, R * 0.05, R * 0.1);
    x.restore();
  }
}

export function partyPopper(x: Ctx, s: Scene) {
  const { R, rx, ry, t } = s;
  confetti(x, s, rx * 1.02, -ry * 0.02, Math.min(1, t / 2.6));
  x.save();
  x.translate(rx * 0.9, ry * 0.34);
  x.rotate(-0.75);
  shadowed(x, s, () => {
    x.beginPath();
    x.moveTo(0, R * 0.34);
    x.lineTo(-R * 0.17, -R * 0.2);
    x.lineTo(R * 0.17, -R * 0.2);
    x.closePath();
    fillLine(x, s, lin(x, [-R * 0.17, 0, R * 0.17, 0], [[0, "#ff8fb1"], [0.5, "#ffb3cb"], [1, "#e0638c"]]));
  });
  x.strokeStyle = "#ffe08a";
  x.lineWidth = R * 0.05;
  for (const y of [-0.06, 0.08]) {
    x.beginPath();
    x.moveTo(-R * (0.12 - y * 0.4), y * R);
    x.lineTo(R * (0.12 - y * 0.4), y * R);
    x.stroke();
  }
  x.beginPath();
  x.ellipse(0, -R * 0.2, R * 0.17, R * 0.05, 0, 0, Math.PI * 2);
  fillLine(x, s, "#ffd15c", 0.02);
  x.restore();
  hand(x, s, rx * 0.76, ry * 0.5, 0.15);
}

// ── Which prop for which act ──────────────────────────────────────────────────

type Prop = (x: Ctx, s: Scene) => void;

/** `${act name}:${variant}` → its props. */
export const CLAUDE_PROPS: Record<string, Prop[]> = {
  "claude:idle": [mug],
  "claude:thinking": [thoughtCloud],
  "claude:working:edit": [keyboard],
  "claude:working:bash": [terminal],
  "claude:working:read": [magnifier],
  "claude:question": [questionBubble],
  "claude:approval": [goldenKey],
  "claude:ratelimit": [hourglass],
  "claude:error": [plaster],
  "claudeEnd:error": [smoke, plaster],
  "claudeEnd:finished": [partyPopper],
};

/** Draws the act's props; an unknown variant draws nothing. */
export function drawClaudeProp(x: Ctx, s: Scene, name: string, variant: string | null) {
  for (const draw of CLAUDE_PROPS[`${name}:${variant ?? ""}`] ?? []) draw(x, s);
}
