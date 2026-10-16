// Mochi's eyes and mouth. Split out of engine.ts (BotEngine.swift port),
// unchanged: each function draws for the engine it is handed.

import { lerp } from "../core/anim";
import type { BotEngine, EyeShape } from "./engine";
import { EYE_H, EYE_P, EYE_SP, EYE_W } from "./geometry";
import { INK, MINI_INK, heartPath, now, roundRectPath, starPath, type BodyDims } from "./engineShapes";

/** One eye, drawn in its own translated and squashed space; `sd` is the side (-1 left, 1 right). */
export interface EyeSpec {
  shape: EyeShape;
  w: number;
  h: number;
  sd: number;
  ink: string;
}

/** What a shape drawer reads: the eye, plus the lids' open amount and the engine clock. */
interface EyeFrame extends EyeSpec {
  open: number;
  t: number;
}

type EyeDrawer = (x: CanvasRenderingContext2D, eye: EyeFrame) => void;

/** The eye shape to draw now: an emote or act override, else the state's, cupped or happy in box mode. */
function eyeShapeFor(e: BotEngine): EyeShape {
  let shape: EyeShape = e.eyeOverride ?? e.actEyeShape ?? e.cfg.eye;
  if (e.morph > 0.5) {
    if (e.isChewing) shape = "happy";
    else if (e.slotHTarget > 0.05 || e.slotH > 0.1) shape = "cup";
  }
  return shape;
}

export function drawEyes(e: BotEngine, x: CanvasRenderingContext2D, body: Path2D, dims: BodyDims) {
  const { R, rx, ry } = dims;
  const shape = eyeShapeFor(e);

  x.save();
  x.clip(body);
  const ink = e.isMini ? MINI_INK : INK;
  x.fillStyle = ink;
  x.strokeStyle = ink;

  for (const sd of [-1, 1]) {
    const eyeYaw = sd * EYE_SP + e.yaw + e.dYaw;
    let eyePitch = EYE_P + e.pitch + e.dPitch + e.roll;
    eyePitch = (((eyePitch + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    const cp = Math.cos(eyePitch);
    if (Math.cos(eyeYaw) * cp <= 0.04) continue;

    const ex = Math.sin(eyeYaw) * cp * rx;
    const ey = -Math.sin(eyePitch) * ry + (e.morph > 0 ? ry * 0.14 * e.morph : 0);
    const fx = lerp(Math.max(0.18, Math.cos(eyeYaw)), 1, e.morph * 0.7);
    const fy = lerp(Math.max(0.18, cp), 1, e.morph * 0.7);
    const eyeMult = e.isMini ? 1.9 : 1.0;
    const ew = R * EYE_W * e.es * eyeMult;
    const eh = R * EYE_H * e.es * eyeMult;

    x.save();
    x.translate(ex, ey);
    x.scale(fx, fy);
    drawEyeShape(e, x, { shape, w: ew, h: eh, sd, ink });
    x.restore();
  }
  x.restore();
}

/** Draws one eye of `eye.shape`, centred on the origin. */
export function drawEyeShape(e: BotEngine, x: CanvasRenderingContext2D, eye: EyeSpec) {
  const t = now();
  EYE_DRAWERS[eye.shape](x, { ...eye, open: e.open, t });
}

/** Rounded pill whose height follows the blink, never thinner than 0.3 of its width. */
function drawPillEye(x: CanvasRenderingContext2D, { w, h, open }: EyeFrame) {
  const hh = Math.max(h * open, w * 0.3);
  roundRectPath(x, { x: -w / 2, y: -hh / 2, w, h: hh }, Math.min(w / 2, hh / 2));
  x.fill();
}

/** Small round dot (surprised). */
function drawDotEye(x: CanvasRenderingContext2D, { w }: EyeFrame) {
  x.beginPath();
  x.arc(0, 0, w * 0.45, 0, Math.PI * 2);
  x.fill();
}

/** Short bar tilted inward (annoyed). */
function drawLineEye(x: CanvasRenderingContext2D, { w, sd }: EyeFrame) {
  x.rotate(-sd * 0.2);
  roundRectPath(x, { x: -w * 0.78, y: -w * 0.21, w: w * 1.56, h: w * 0.42 }, w * 0.21);
  x.fill();
}

/** Level bar (error). */
function drawFlatEye(x: CanvasRenderingContext2D, { w }: EyeFrame) {
  roundRectPath(x, { x: -w * 0.72, y: -w * 0.2, w: w * 1.44, h: w * 0.4 }, w * 0.2);
  x.fill();
}

/** Upward arc, a smiling eye (prototype angles, see the header). */
function drawHappyEye(x: CanvasRenderingContext2D, { w, h }: EyeFrame) {
  x.lineWidth = w * 0.5;
  x.lineCap = "round";
  x.beginPath();
  x.arc(0, h * 0.18, w * 0.82, Math.PI * 1.12, Math.PI * 1.88);
  x.stroke();
}

/** Downward arc, a shut eye (sleeping). */
function drawClosedEye(x: CanvasRenderingContext2D, { w, h }: EyeFrame) {
  x.lineWidth = w * 0.36;
  x.lineCap = "round";
  x.beginPath();
  x.arc(0, -h * 0.08, w * 0.78, Math.PI * 0.15, Math.PI * 0.85);
  x.stroke();
}

/** Spinning spiral, each eye turning its own way (dizzy). */
function drawSpiralEye(x: CanvasRenderingContext2D, { w, sd, t }: EyeFrame) {
  x.lineWidth = w * 0.22;
  x.lineCap = "round";
  x.beginPath();
  for (let a = 0; a < 4.4 * Math.PI; a += 0.2) {
    const r = w * 0.06 + a * w * 0.058;
    const aa = a + t * 9 * sd;
    const px = Math.cos(aa) * r;
    const py = Math.sin(aa) * r;
    if (a === 0) x.moveTo(px, py);
    else x.lineTo(px, py);
  }
  x.stroke();
}

/** Pink heart (love); puts the ink back after. */
function drawHeartEye(x: CanvasRenderingContext2D, { w, ink }: EyeFrame) {
  x.fillStyle = "#FF4D6D";
  heartPath(x, w * 1.2);
  x.fill();
  x.fillStyle = ink;
}

/** Turning gold star (proud); puts the ink back after. */
function drawStarEye(x: CanvasRenderingContext2D, { w, sd, t, ink }: EyeFrame) {
  x.fillStyle = "#F7B32B";
  x.rotate(t * 1.5 * sd);
  starPath(x, w * 1.05, w * 0.46);
  x.fill();
  x.fillStyle = ink;
}

/** Half-shut eye under a heavy lid (yawn, rate limit). */
function drawTiredEye(x: CanvasRenderingContext2D, { w, h }: EyeFrame) {
  roundRectPath(x, { x: -w / 2, y: -h * 0.02, w, h: h * 0.38 }, w / 2);
  x.fill();
  roundRectPath(x, { x: -w * 0.62, y: -h * 0.1, w: w * 1.24, h: w * 0.22 }, w * 0.11);
  x.fill();
}

/** Left eye open, right eye smiling shut. */
function drawWinkEye(x: CanvasRenderingContext2D, eye: EyeFrame) {
  if (eye.sd < 0) drawPillEye(x, eye);
  else drawHappyEye(x, eye);
}

/** Flat top, rounded bottom corners (U shape), used while the box is open. */
function drawCupEye(x: CanvasRenderingContext2D, { w, h, open }: EyeFrame) {
  const hh = Math.max(h * open, w * 0.3);
  const cr = Math.min(w / 2, hh / 2);
  x.beginPath();
  x.moveTo(-w / 2, -hh / 2);
  x.lineTo(w / 2, -hh / 2);
  x.lineTo(w / 2, hh / 2 - cr);
  x.quadraticCurveTo(w / 2, hh / 2, w / 2 - cr, hh / 2);
  x.lineTo(-w / 2 + cr, hh / 2);
  x.quadraticCurveTo(-w / 2, hh / 2, -w / 2, hh / 2 - cr);
  x.closePath();
  x.fill();
}

/** Each eye shape's drawer; `wide` is a bigger pill. */
const EYE_DRAWERS: Record<EyeShape, EyeDrawer> = {
  wide: (x, eye) => drawPillEye(x, { ...eye, w: eye.w * 1.16, h: eye.h * 1.12 }),
  pill: drawPillEye,
  dot: drawDotEye,
  line: drawLineEye,
  flat: drawFlatEye,
  happy: drawHappyEye,
  closed: drawClosedEye,
  spiral: drawSpiralEye,
  heart: drawHeartEye,
  star: drawStarEye,
  tired: drawTiredEye,
  wink: drawWinkEye,
  cup: drawCupEye,
};

/** Mailbox slot: dark pill cut into the box face, with rim and lip highlights. */
export function drawMouth(e: BotEngine, x: CanvasRenderingContext2D, body: Path2D, R: number) {
  const m = e.morph;
  const hW = R * 1.8 * m;
  const hH = e.slotH * R * m;
  const hX = -hW / 2;
  const boxTop = -R * (0.88 + 0.06 * m);
  const hY = boxTop + R * 0.08 * m;

  x.save();
  x.clip(body);

  x.strokeStyle = `rgba(255,255,255,${0.55 * m})`;
  x.lineWidth = 1;
  x.lineCap = "round";
  x.beginPath();
  x.moveTo(-R * 0.9 * m, boxTop + 1);
  x.lineTo(R * 0.9 * m, boxTop + 1);
  x.stroke();

  if (hH > 0.8) {
    const hR = Math.min(hW / 2, hH / 2);
    const g = x.createLinearGradient(0, hY, 0, hY + hH);
    g.addColorStop(0, "rgb(7,8,10)");
    g.addColorStop(1, "rgb(16,19,26)");
    roundRectPath(x, { x: hX, y: hY, w: hW, h: hH }, hR);
    x.fillStyle = g;
    x.fill();
    if (hH > 4) {
      const lipR = Math.min(hR, (hW - 2) / 2);
      x.strokeStyle = `rgba(255,255,255,${0.28 * m})`;
      x.beginPath();
      x.moveTo(hX + lipR, hY + hH - 0.5);
      x.lineTo(hX + hW - lipR, hY + hH - 0.5);
      x.stroke();
    }
  }
  x.restore();
}
