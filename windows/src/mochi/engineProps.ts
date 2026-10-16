// The props Mochi's acts wear (headband, mic, envelope, box, hard hat,
// clipboard, waving hands), drawn in code in body space so they follow the
// pose. Split out of engine.ts, unchanged.

import { lerp } from "../core/anim";
import { actShowsHands, type Act } from "./acts";
import { PROP_SCALE, drawClaudeProp } from "./claudeProps";
import type { BotEngine } from "./engine";
import {
  BASE_BOTTOM, BASE_TOP, COMPACT_R, GRAPHITE, heartPath, mix3, now, rgba, roundRectPath,
  type BodyDims,
} from "./engineShapes";
import { ENVELOPE, envelopeParts } from "./geometry";
import { drawMusicProp } from "./musicProps";

// ── Act props: all drawn in code, in body space so they follow the pose ──────

export function drawProps(e: BotEngine, x: CanvasRenderingContext2D, body: BodyDims, act: Act, alpha: number) {
  const { R, rx, ry } = body;
  const p = e.props;
  x.save();
  x.globalAlpha = alpha;
  switch (act.name) {
    case "mic": drawMicHeadset(e, x, body, act.variant === "muted"); break;
    case "mail": drawEnvelope(x, R, p.show, p.flap); break;
    case "catch": drawBox(x, R, ry, p.show, p.fall); break;
    case "check":
      drawHardHat(x, body, p.show);
      drawClipboard(x, body, p.show, p.stroke);
      break;
    case "claude":
    case "claudeEnd":
      // lastActAge: a one-shot's age, or the free clock for a continuous act.
      drawClaudeProp(x, { R: R * PROP_SCALE, rx, ry, t: e.lastActAge }, act.name, act.variant);
      break;
    case "music":
    case "musicCue":
      drawMusicProp(x, { R: R * PROP_SCALE, rx, ry, t: e.lastActAge }, act.name, act.variant);
      break;
  }
  x.restore();
}

/** Headband over the head; returns the sideways shift that follows the head turn. */
export function drawHeadband(e: BotEngine, x: CanvasRenderingContext2D, body: BodyDims): number {
  const { R, rx, ry } = body;
  const shift = Math.sin(e.yaw + e.dYaw) * rx * 0.1;
  const bandY = -ry * 0.08;
  const bandW = Math.max(1.2, R * 0.12);
  x.lineCap = "round";
  x.strokeStyle = GRAPHITE;
  x.lineWidth = bandW;
  x.beginPath();
  x.ellipse(shift * 0.5, bandY, rx * 0.98, ry * 1.12, 0, Math.PI * 1.04, Math.PI * 1.96);
  x.stroke();
  x.strokeStyle = "rgba(255,255,255,0.22)";
  x.lineWidth = bandW * 0.3;
  x.beginPath();
  x.ellipse(shift * 0.5, bandY, rx * 0.98, ry * 1.12, 0, Math.PI * 1.25, Math.PI * 1.6);
  x.stroke();
  return shift;
}

export function drawEarCup(x: CanvasRenderingContext2D, R: number, cx: number, cy: number, scale = 1) {
  const w = R * 0.3 * scale;
  const h = R * 0.58 * scale;
  x.save();
  x.translate(cx, cy);
  const g = x.createLinearGradient(0, -h / 2, 0, h / 2);
  g.addColorStop(0, "rgb(84,89,103)");
  g.addColorStop(1, "rgb(36,39,47)");
  roundRectPath(x, { x: -w / 2, y: -h / 2, w, h }, w * 0.45);
  x.fillStyle = g;
  x.fill();
  x.strokeStyle = "rgba(255,255,255,0.18)";
  x.lineWidth = Math.max(0.8, R * 0.03);
  roundRectPath(x, { x: -w * 0.32, y: -h * 0.36, w: w * 0.64, h: h * 0.72 }, w * 0.3);
  x.stroke();
  x.restore();
}

/** Audio: a call headset, boom mic to the mouth; sound waves, or a red muted mic. */
export function drawMicHeadset(e: BotEngine, x: CanvasRenderingContext2D, body: BodyDims, muted: boolean) {
  const { R, rx, ry } = body;
  const shift = drawHeadband(e, x, body);
  drawEarCup(x, R, rx * 0.97 + shift, -ry * 0.04, 0.8);
  const lx = -rx * 0.97 + shift;
  const ly = -ry * 0.04;
  const mx = -rx * 0.32 + shift * 1.5;
  const my = ry * 0.52;
  x.lineCap = "round";
  x.strokeStyle = GRAPHITE;
  x.lineWidth = Math.max(1, R * 0.07);
  x.beginPath();
  x.moveTo(lx, ly + R * 0.1);
  x.quadraticCurveTo(lx + rx * 0.05, my + ry * 0.08, mx, my);
  x.stroke();
  drawEarCup(x, R, lx, ly);

  x.beginPath();
  x.ellipse(mx, my, R * 0.11, R * 0.085, 0, 0, Math.PI * 2);
  x.fillStyle = muted ? "rgb(244,80,94)" : "rgb(84,89,103)";
  x.fill();
  x.fillStyle = "rgba(255,255,255,0.3)";
  x.beginPath();
  x.ellipse(mx - R * 0.03, my - R * 0.03, R * 0.04, R * 0.025, 0, 0, Math.PI * 2);
  x.fill();

  if (muted) {
    x.strokeStyle = "#fff";
    x.lineWidth = Math.max(0.8, R * 0.03);
    x.beginPath();
    x.moveTo(mx - R * 0.07, my + R * 0.055);
    x.lineTo(mx + R * 0.07, my - R * 0.055);
    x.stroke();
    return;
  }
  const t = now();
  x.lineWidth = Math.max(1, R * 0.055);
  for (let i = 0; i < 3; i++) {
    const ph = (t * 1.4 + i / 3) % 1;
    x.strokeStyle = `rgba(255,255,255,${0.95 * (1 - ph)})`;
    x.beginPath();
    x.arc(mx, my, R * (0.2 + 0.32 * ph), Math.PI * 0.5, Math.PI * 1.1);
    x.stroke();
  }
}

/** The envelope's size in px and its flap's apex y, shared by its parts. */
interface EnvelopeBox {
  R: number;
  w: number;
  h: number;
  apex: number;
}

const ENVELOPE_EDGE = "rgba(0,0,0,0.18)";

/**
 * Messages: an envelope pops up, held low in front of the body; the flap
 * opens on a letter. Geometry in mochi/geometry.ts keeps it below the eyes.
 */
export function drawEnvelope(x: CanvasRenderingContext2D, R: number, show: number, flap: number) {
  if (show <= 0.01) return;
  const E = ENVELOPE;
  const w = R * E.w;
  const h = R * E.h;
  const parts = envelopeParts(flap);
  const env: EnvelopeBox = { R, w, h, apex: R * parts.apex };
  x.save();
  x.translate(0, R * E.cy);
  x.rotate(E.tilt);
  x.scale(show, show);
  x.lineWidth = 1;
  x.lineJoin = "round";
  if (parts.letterY !== null) drawOpenFlap(x, env, R * parts.letterY);
  drawPocket(x, env);
  if (parts.heartY !== null) drawClosedFlap(x, env, R * parts.heartY);
  x.restore();
}

/** The triangular flap, filled in `fill` and edged. */
function drawFlap(x: CanvasRenderingContext2D, env: EnvelopeBox, fill: string) {
  const { w, h, apex } = env;
  x.beginPath();
  x.moveTo(-w / 2, -h / 2);
  x.lineTo(w / 2, -h / 2);
  x.lineTo(0, apex);
  x.closePath();
  x.fillStyle = fill;
  x.fill();
  x.strokeStyle = ENVELOPE_EDGE;
  x.stroke();
}

/** Open: flap behind, the letter (top at `ly`) rising out of the pocket. */
function drawOpenFlap(x: CanvasRenderingContext2D, env: EnvelopeBox, ly: number) {
  const { R, w, h } = env;
  drawFlap(x, env, "rgb(232,228,218)");
  roundRectPath(x, { x: (-w * ENVELOPE.letterW) / 2, y: ly, w: w * ENVELOPE.letterW, h: h * ENVELOPE.letterH }, R * 0.04);
  x.fillStyle = "#fff";
  x.fill();
  x.stroke();
  x.strokeStyle = "rgba(0,0,0,0.25)";
  x.lineWidth = Math.max(0.6, R * 0.025);
  for (let i = 0; i < 2; i++) {
    x.beginPath();
    x.moveTo(-w * 0.26, ly + h * (0.14 + i * 0.14));
    x.lineTo(w * (0.2 - i * 0.12), ly + h * (0.14 + i * 0.14));
    x.stroke();
  }
  x.lineWidth = 1;
}

/** The envelope's body, with the fold lines of its front pocket. */
function drawPocket(x: CanvasRenderingContext2D, env: EnvelopeBox) {
  const { R, w, h } = env;
  roundRectPath(x, { x: -w / 2, y: -h / 2, w, h }, R * 0.06);
  x.fillStyle = "rgb(252,250,244)";
  x.fill();
  x.strokeStyle = ENVELOPE_EDGE;
  x.stroke();
  x.strokeStyle = "rgba(0,0,0,0.12)";
  x.beginPath();
  x.moveTo(-w / 2, h / 2);
  x.lineTo(0, -h * 0.02);
  x.lineTo(w / 2, h / 2);
  x.stroke();
}

/** Closed: the flap down in front, sealed with a heart at `heartY`. */
function drawClosedFlap(x: CanvasRenderingContext2D, env: EnvelopeBox, heartY: number) {
  drawFlap(x, env, "rgb(240,236,227)");
  x.save();
  x.translate(0, heartY);
  heartPath(x, env.R * ENVELOPE.heart);
  x.fillStyle = "#FF4D6D";
  x.fill();
  x.restore();
}

/** Shelf: a cardboard box on the head; a file sheet falls into it. */
export function drawBox(x: CanvasRenderingContext2D, R: number, ry: number, show: number, fall: number) {
  if (show <= 0.01) return;
  const w = R * 0.95;
  const h = R * 0.52;
  const baseY = -ry * 0.8; // sunk a little into the head
  const top = baseY - h;
  x.save();
  x.translate(0, baseY);
  x.scale(show, show);
  x.translate(0, -baseY);

  // The sheet goes behind the front face, so once in it only peeks out.
  drawFallingSheet(x, R, top, fall);
  drawCardboardBox(x, R, { w, h, top, baseY });
  x.restore();
}

/** The file sheet, falling (`fall` 0…1) toward the box's open `top`. */
function drawFallingSheet(x: CanvasRenderingContext2D, R: number, top: number, fall: number) {
  const sw = R * 0.42;
  const sh = R * 0.54;
  const y = lerp(top - R * 2.4, top - sh * 0.12, fall * fall);
  x.save();
  x.translate(R * 0.04, y);
  x.rotate((1 - fall) * 0.5);
  roundRectPath(x, { x: -sw / 2, y: -sh / 2, w: sw, h: sh }, R * 0.03);
  x.fillStyle = "#fff";
  x.fill();
  x.strokeStyle = "rgba(0,0,0,0.18)";
  x.lineWidth = 1;
  x.stroke();
  x.fillStyle = "rgb(220,224,232)";
  x.beginPath();
  x.moveTo(sw / 2 - sw * 0.3, -sh / 2);
  x.lineTo(sw / 2, -sh / 2 + sw * 0.3);
  x.lineTo(sw / 2 - sw * 0.3, -sh / 2 + sw * 0.3);
  x.closePath();
  x.fill();
  x.strokeStyle = "rgba(0,0,0,0.22)";
  x.lineWidth = Math.max(0.6, R * 0.025);
  for (let i = 0; i < 3; i++) {
    x.beginPath();
    x.moveTo(-sw * 0.3, -sh * 0.12 + i * sh * 0.16);
    x.lineTo(sw * (0.3 - (i === 2 ? 0.2 : 0)), -sh * 0.12 + i * sh * 0.16);
    x.stroke();
  }
  x.restore();
}

/** The open box: front face from `top` down to `baseY`, a tape strip and two flaps. */
function drawCardboardBox(
  x: CanvasRenderingContext2D, R: number, box: { w: number; h: number; top: number; baseY: number },
) {
  const { w, h, top, baseY } = box;
  const g = x.createLinearGradient(0, top, 0, baseY);
  g.addColorStop(0, "rgb(214,163,104)");
  g.addColorStop(1, "rgb(176,128,76)");
  roundRectPath(x, { x: -w / 2, y: top, w, h }, R * 0.05);
  x.fillStyle = g;
  x.fill();
  x.fillStyle = "rgba(255,236,200,0.45)";
  x.fillRect(-w * 0.09, top, w * 0.18, h);
  x.fillStyle = "rgb(196,146,90)";
  for (const sd of [-1, 1]) {
    x.beginPath();
    x.moveTo(sd * w / 2, top);
    x.lineTo(sd * (w / 2 + w * 0.2), top - h * 0.38);
    x.lineTo(sd * w * 0.08, top - h * 0.3);
    x.lineTo(sd * w * 0.04, top);
    x.closePath();
    x.fill();
  }
}

/** Space: a hard hat. */
export function drawHardHat(x: CanvasRenderingContext2D, body: BodyDims, show: number) {
  if (show <= 0.01) return;
  const { R, rx, ry } = body;
  x.save();
  x.translate(0, -ry * 0.72);
  x.scale(show, show);
  const g = x.createLinearGradient(0, -ry * 0.62, 0, 0);
  g.addColorStop(0, "rgb(255,214,92)");
  g.addColorStop(1, "rgb(232,160,30)");
  x.beginPath();
  x.ellipse(0, 0, rx * 0.74, ry * 0.62, 0, Math.PI, Math.PI * 2);
  x.closePath();
  x.fillStyle = g;
  x.fill();
  x.fillStyle = "rgba(255,255,255,0.35)";
  roundRectPath(x, { x: -R * 0.07, y: -ry * 0.6, w: R * 0.14, h: ry * 0.58 }, R * 0.07);
  x.fill();
  roundRectPath(x, { x: -rx * 0.98, y: -R * 0.04, w: rx * 1.96, h: R * 0.12 }, R * 0.06);
  x.fillStyle = "rgb(226,150,24)";
  x.fill();
  x.restore();
}

/** Space: a clipboard at the side; the check mark draws itself. */
export function drawClipboard(x: CanvasRenderingContext2D, body: BodyDims, show: number, stroke: number) {
  if (show <= 0.01) return;
  const { R, rx, ry } = body;
  const w = R * 0.62;
  const h = R * 0.8;
  x.save();
  x.translate(rx * 0.98, ry * 0.3);
  x.rotate(-0.16);
  x.scale(show, show);
  roundRectPath(x, { x: -w / 2, y: -h / 2, w, h }, R * 0.07);
  x.fillStyle = "rgb(176,125,76)";
  x.fill();
  roundRectPath(x, { x: -w * 0.38, y: -h * 0.38, w: w * 0.76, h: h * 0.8 }, R * 0.03);
  x.fillStyle = "#fff";
  x.fill();
  roundRectPath(x, { x: -w * 0.2, y: -h / 2 - R * 0.05, w: w * 0.4, h: R * 0.13 }, R * 0.04);
  x.fillStyle = "rgb(84,89,103)";
  x.fill();
  x.strokeStyle = "rgba(0,0,0,0.2)";
  x.lineWidth = Math.max(0.6, R * 0.025);
  x.beginPath();
  x.moveTo(-w * 0.26, -h * 0.22);
  x.lineTo(w * 0.26, -h * 0.22);
  x.stroke();
  if (stroke > 0) drawCheckMark(x, R, w, h, stroke);
  x.restore();
}

/** The green check on a `w`×`h` clipboard, drawn up to `stroke` (0…1) of its length. */
function drawCheckMark(x: CanvasRenderingContext2D, R: number, w: number, h: number, stroke: number) {
  const pts: [number, number][] = [[-0.2 * w, 0.08 * h], [-0.04 * w, 0.24 * h], [0.24 * w, -0.06 * h]];
  const seg = [Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1])];
  let left = stroke * (seg[0] + seg[1]);
  x.strokeStyle = "rgb(52,212,153)";
  x.lineWidth = R * 0.09;
  x.lineCap = "round";
  x.lineJoin = "round";
  x.beginPath();
  x.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < 2 && left > 0; i++) {
    const k = Math.min(1, left / seg[i]);
    x.lineTo(lerp(pts[i][0], pts[i + 1][0], k), lerp(pts[i][1], pts[i + 1][1], k));
    left -= seg[i];
  }
  x.stroke();
}

// ── Hands ─────────────────────────────────────────────────────────────────────

/** The body as drawn this frame (centre, tilt, squash), for the hands behind it. */
export interface HandsPose extends BodyDims {
  cx: number;
  cy: number;
  tilt: number;
  sx: number;
  sy: number;
}

/** What both hands share in a frame: the clock, body height and half-extents, and the wave. */
interface HandFrame {
  n: number;
  bodyH: number;
  hwB: number;
  hhB: number;
  isWaving: boolean;
}

/** A hand's spot in body space and its rotation. */
interface HandPlace {
  localX: number;
  localY: number;
  handRot: number;
}

/** Angular speed of the wave, in radians per second. */
const WAVE_RATE = 13;
/** Seconds the waving hand takes to rise into the wave. */
const WAVE_RISE_S = 0.18;

/** Hands sit behind the body: drawn before it, in world coordinates. */
export function drawHandsBehind(e: BotEngine, x: CanvasRenderingContext2D, pose: HandsPose) {
  if (e.isMini) return;
  // Some acts bring the hands out too, independent of the greet's own tween.
  const amount = Math.max(e.hands, actShowsHands(e.shown) ? e.actAmt : 0);
  if (amount <= 0.01) return;
  const { R, rx, ry, cx, cy, tilt, sx, sy } = pose;
  if (R <= COMPACT_R) return; // meaningless at compact/peek sizes

  const n = now();
  const frame: HandFrame = {
    n,
    bodyH: 2 * ry,
    hwB: rx * sx,
    hhB: ry * sy,
    isWaving: n >= e.waveStart && e.waveStart > 0 && n < e.waveUntil,
  };
  const size = { w: 0.3 * ry * amount, h: 0.26 * ry * amount };

  for (const sd of [-1, 1]) {
    const { localX, localY, handRot } = handPlace(e, sd, frame);
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);
    const worldX = cx + cosT * localX - sinT * localY;
    const worldY = cy + sinT * localX + cosT * localY;
    drawHand(e, x, { x: worldX, y: worldY, rot: handRot }, size);
  }
}

/** Where hand `sd` (-1 left, 1 right) sits: waving, steadying the wave, or dancing. */
function handPlace(e: BotEngine, sd: number, f: HandFrame): HandPlace {
  if (sd > 0 && f.isWaving) return wavingHand(e, f);
  if (sd < 0 && f.isWaving) {
    const wt = f.n - e.waveStart;
    return { localX: -f.hwB * 1.08, localY: f.hhB * 0.7 + Math.sin(6 * wt) * 0.04 * f.bodyH, handRot: 0 };
  }
  // Dance: hands take turns going up, opposite to the lean (0 when not dancing).
  const up = sd < 0 ? e.dHandL : e.dHandR;
  return {
    localX: sd * f.hwB * lerp(1.08, 1.18, up),
    localY: lerp(f.hhB * 0.7, -f.hhB * 0.3, up),
    handRot: -sd * 0.45 * up,
  };
}

/** The right hand rising from rest into the wave, then swinging. */
function wavingHand(e: BotEngine, f: HandFrame): HandPlace {
  const wt = f.n - e.waveStart;
  const rise = Math.min(1, wt / WAVE_RISE_S);
  const riseEased = 1 - Math.pow(1 - rise, 3);
  const restX = f.hwB * 1.08;
  const restY = f.hhB * 0.7;
  const oscX = Math.cos(WAVE_RATE * wt) * 0.06 * f.bodyH;
  const oscY = -Math.sin(WAVE_RATE * wt) * 0.14 * f.bodyH;
  const waveX = f.hwB * 1.1 + oscX;
  const waveY = -f.hhB * 0.15 + oscY;
  return {
    localX: restX + (waveX - restX) * riseEased,
    localY: restY + (waveY - restY) * riseEased,
    handRot: (-0.5 + Math.sin(WAVE_RATE * wt) * 0.35) * riseEased,
  };
}

/** One hand: a small body-coloured ellipse of half-size `size`, at `at` in world space. */
function drawHand(
  e: BotEngine, x: CanvasRenderingContext2D,
  at: { x: number; y: number; rot: number }, size: { w: number; h: number },
) {
  const hew = size.w;
  const heh = size.h;
  x.save();
  x.translate(at.x, at.y);
  if (at.rot !== 0) x.rotate(at.rot);
  const g = x.createLinearGradient(hew * 0.7, -heh * 0.85, -hew * 0.8, heh * 0.9);
  if (e.bodyColor) {
    g.addColorStop(0, rgba(mix3(e.bodyColor, [1, 1, 1], 0.35)));
    g.addColorStop(1, rgba(e.bodyColor));
  } else {
    g.addColorStop(0, rgba(BASE_TOP));
    g.addColorStop(1, rgba(BASE_BOTTOM));
  }
  x.beginPath();
  x.ellipse(0, 0, hew, heh, 0, 0, Math.PI * 2);
  x.fillStyle = g;
  x.fill();
  x.strokeStyle = "rgba(0,0,0,0.08)";
  x.lineWidth = 1;
  x.stroke();
  x.restore();
}
