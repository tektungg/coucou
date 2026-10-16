// What floats around Mochi: the badge (mini bots) and the particles (hearts,
// stars, sweat, z's, notes). Split out of engine.ts, unchanged.

import type { Badge, BotEngine } from "./engine";
import { COMPACT_R, FONT, heartPath, now, rgba, roundRectPath, starPath } from "./engineShapes";

/** Where the body sits in canvas space: its radius R and its centre. */
export interface BodyAnchor {
  R: number;
  cx: number;
  cy: number;
}

type Particle = BotEngine["particles"][number];
type ParticleDrawer = (x: CanvasRenderingContext2D, p: Particle, sz: number, R: number) => void;

/** Beats per second of the badge's typing dots. */
const DOTS_RATE = 2.4;

export function drawBadge(e: BotEngine, x: CanvasRenderingContext2D, badge: Badge, at: BodyAnchor) {
  const { R, cx, cy } = at;
  const bs = e.badgeS * (e.isMini ? 1.25 : 1);
  const bx = cx - R * 0.72 * e.sx;
  const by = cy - R * 0.72 * e.sy;
  const t = now();

  x.save();
  x.translate(bx, by);
  x.scale(bs, bs);
  const col = rgba(badge.color);

  if (badge.kind === "dots") {
    if (e.isMini) drawMiniDotsBadge(x, R, t, col);
    else drawTypingBadge(x, R, t, col);
  } else if (badge.kind === "bang" || badge.kind === "question") {
    ringedDot(x, col, R * 0.3, R * 0.23);
    if (!e.isMini) drawBadgeGlyph(x, R, badge.kind === "bang" ? "!" : "?");
  } else {
    ringedDot(x, col, R * 0.2, R * 0.135);
  }
  x.restore();
}

/** A black disc of radius `outer` with a `col` disc of radius `inner` on top, at the origin. */
function ringedDot(x: CanvasRenderingContext2D, col: string, outer: number, inner: number) {
  x.fillStyle = "#000";
  x.beginPath();
  x.arc(0, 0, outer, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = col;
  x.beginPath();
  x.arc(0, 0, inner, 0, Math.PI * 2);
  x.fill();
}

/** Mini bots: one pulsing dot stands in for the three typing dots. */
function drawMiniDotsBadge(x: CanvasRenderingContext2D, R: number, t: number, col: string) {
  const phase = (t * DOTS_RATE) % 1;
  const dotR = R * 0.22 * (1 + 0.25 * Math.sin(phase * Math.PI * 2));
  ringedDot(x, col, R * 0.2, dotR);
}

/** A coloured pill with three white dots bouncing in turn. */
function drawTypingBadge(x: CanvasRenderingContext2D, R: number, t: number, col: string) {
  const pw = R * 0.72;
  const ph = R * 0.36;
  roundRectPath(x, { x: -pw / 2, y: -ph / 2, w: pw, h: ph }, ph / 2);
  x.fillStyle = col;
  x.fill();
  for (let i = 0; i < 3; i++) {
    const phase = (((t * DOTS_RATE - i * 0.22) % 1) + 1) % 1;
    const dotR = R * 0.055 * (1 + 0.4 * Math.max(0, Math.sin(phase * Math.PI * 2)));
    x.fillStyle = "#fff";
    x.beginPath();
    x.arc((i - 1) * R * 0.18, 0, dotR, 0, Math.PI * 2);
    x.fill();
  }
}

/** The badge's white "!" or "?". */
function drawBadgeGlyph(x: CanvasRenderingContext2D, R: number, glyph: string) {
  x.fillStyle = "#fff";
  x.font = `900 ${R * 0.32}px ${FONT}`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(glyph, 0, R * 0.02);
}

export function drawParticles(e: BotEngine, x: CanvasRenderingContext2D, at: BodyAnchor) {
  const { R, cx, cy } = at;
  for (const p of e.particles) {
    if (p.age <= 0) continue;
    const k = p.age / p.life;
    const a = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
    const px = cx + (p.x + p.vx * p.age) * R * 1.3;
    const py = cy + (p.y + p.vy * p.age) * R * 1.3;
    const sz = R * p.size * (1 + k * 0.4);

    x.save();
    x.translate(px, py);
    x.globalAlpha = Math.min(1, Math.max(0, a));
    PARTICLE_DRAWERS[p.type](x, p, sz, R);
    x.restore();
  }
}

/** Falling drop (rate limit). */
function drawSweat(x: CanvasRenderingContext2D, _p: Particle, sz: number) {
  x.fillStyle = "#7CC7FF";
  x.beginPath();
  x.moveTo(0, -sz);
  x.quadraticCurveTo(sz * 0.8, sz * 0.2, 0, sz * 0.6);
  x.quadraticCurveTo(-sz * 0.8, sz * 0.2, 0, -sz);
  x.fill();
}

/** Swaying eighth note (music); skipped at compact size, where it is just noise. */
function drawNote(x: CanvasRenderingContext2D, p: Particle, sz: number, R: number) {
  if (R <= COMPACT_R) return;
  const s = sz * 1.15;
  x.rotate(Math.sin(p.age * 5) * 0.25);
  x.fillStyle = "rgba(255,255,255,0.92)";
  x.strokeStyle = "rgba(255,255,255,0.92)";
  x.beginPath();
  x.ellipse(-s * 0.22, s * 0.45, s * 0.3, s * 0.22, -0.4, 0, Math.PI * 2);
  x.fill();
  x.lineWidth = s * 0.13;
  x.lineCap = "round";
  x.beginPath();
  x.moveTo(s * 0.05, s * 0.42);
  x.lineTo(s * 0.05, -s * 0.6);
  x.quadraticCurveTo(s * 0.5, -s * 0.35, s * 0.42, s * 0.02);
  x.stroke();
}

/** A sleepy "z". */
function drawZ(x: CanvasRenderingContext2D, _p: Particle, sz: number) {
  x.fillStyle = "rgb(209,219,235)";
  x.font = `700 ${sz * 1.9}px ${FONT}`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText("z", 0, 0);
}

/** Each particle type's drawer, in the particle's translated, faded space. */
const PARTICLE_DRAWERS: Record<Particle["type"], ParticleDrawer> = {
  heart: (x, p, sz) => {
    x.rotate(Math.sin(p.age * 6) * 0.3);
    x.fillStyle = "#FF4D6D";
    heartPath(x, sz);
    x.fill();
  },
  star: (x, p, sz) => {
    x.rotate(p.rot + p.age * 2);
    x.fillStyle = "#F7B32B";
    starPath(x, sz, sz * 0.45);
    x.fill();
  },
  spark: (x, p, sz) => {
    x.rotate(p.rot);
    x.fillStyle = "#fff";
    starPath(x, sz * 0.8, sz * 0.18);
    x.fill();
  },
  sweat: drawSweat,
  note: drawNote,
  z: drawZ,
};
