// Sunglasses and round glasses, pinned to the real eye positions. Both share
// one frame (bridge and temples); only the lenses differ.
// Part of ../outfits.ts, ported from upstream (Louis-CFM/coucou 23c09b9, c97dec1).

import { eyeFrames, type Ctx, type EyeFrame, type Head } from "./head";
import { roundRect } from "./paint";

/** How a frame is drawn round its lenses. Heights are fractions of h, widths of R. */
interface Frame {
  color: string;
  /** Lens width and height, in px. */
  w: number;
  h: number;
  /** Where the bridge starts, as a fraction of the half-lens width out from the eye. */
  inset: number;
  /** The bridge: height of its ends, lift of its middle, line width. */
  bridge: readonly [y: number, lift: number, width: number];
  /** The temples: height at the lens, height at the head's side, line width. */
  temple: readonly [y0: number, y1: number, width: number];
}

/** A lens drawn centred on (0, 0), already squashed to the eye. */
type Lens = (ctx: Ctx) => void;

/** The temples reach just past the head's side. */
const TEMPLE_REACH = 1.05;

export function sunglasses(ctx: Ctx, H: Head, body: Path2D) {
  const w = H.R * 0.62;
  const h = H.R * 0.46;
  const frame: Frame = { color: "#111317", w, h, inset: 0.9, bridge: [0.18, 0.42, 0.07], temple: [0.2, 0.35, 0.06] };
  drawGlasses(ctx, H, body, frame, (c) => sunLens(c, H, frame));
}

export function roundGlasses(ctx: Ctx, H: Head, body: Path2D) {
  const d = H.R * 0.56;
  const frame: Frame = { color: "#8A4B12", w: d, h: d, inset: 1, bridge: [0.08, 0.3, 0.055], temple: [0.1, 0.25, 0.05] };
  drawGlasses(ctx, H, body, frame, (c) => roundLens(c, H, d));
}

/** The frame, then each visible lens, clipped to the body. */
function drawGlasses(ctx: Ctx, H: Head, body: Path2D, frame: Frame, lens: Lens) {
  const eyes = eyeFrames(H);
  ctx.save();
  ctx.clip(body);
  ctx.strokeStyle = frame.color;
  ctx.lineCap = "round";
  drawBridge(ctx, H, eyes, frame);
  drawTemples(ctx, H, eyes, frame);
  for (const e of eyes) {
    if (!e.visible) continue;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.scale(e.fx, e.fy);
    lens(ctx);
    ctx.restore();
  }
  ctx.restore();
}

/** The bridge over the nose, only when both lenses show. */
function drawBridge(ctx: Ctx, H: Head, eyes: EyeFrame[], frame: Frame) {
  const [l, r] = eyes;
  if (!l.visible || !r.visible) return;
  const { w, h, inset } = frame;
  const [y, lift, width] = frame.bridge;
  ctx.beginPath();
  ctx.moveTo(l.x + (w / 2) * l.fx * inset, l.y - h * y);
  ctx.quadraticCurveTo((l.x + r.x) / 2, (l.y + r.y) / 2 - h * lift, r.x - (w / 2) * r.fx * inset, r.y - h * y);
  ctx.lineWidth = H.R * width;
  ctx.stroke();
}

/** A temple from each visible lens back to the side of the head. */
function drawTemples(ctx: Ctx, H: Head, eyes: EyeFrame[], frame: Frame) {
  const { w, h } = frame;
  const [y0, y1, width] = frame.temple;
  ctx.lineWidth = H.R * width;
  for (const e of eyes) {
    if (!e.visible) continue;
    ctx.beginPath();
    ctx.moveTo(e.x + (e.sd * w) / 2 * e.fx, e.y - h * y0);
    ctx.lineTo(e.sd * H.rx * TEMPLE_REACH, e.y - h * y1);
    ctx.stroke();
  }
}

/** A dark rounded lens with a glint. */
function sunLens(ctx: Ctx, H: Head, frame: Frame) {
  const { w, h } = frame;
  roundRect(ctx, { x: -w / 2, y: -h / 2, w, h }, h * 0.42);
  ctx.fillStyle = "rgba(17,19,23,0.82)";
  ctx.fill();
  ctx.lineWidth = H.R * 0.05;
  ctx.strokeStyle = "#0B0C0F";
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-w * 0.28, -h * 0.05);
  ctx.lineTo(-w * 0.05, -h * 0.3);
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.stroke();
}

/** A clear round lens of diameter d in a brown rim, with a glint. */
function roundLens(ctx: Ctx, H: Head, d: number) {
  ctx.beginPath();
  ctx.arc(0, 0, d / 2, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(190,225,255,0.18)";
  ctx.fill();
  ctx.lineWidth = H.R * 0.065;
  ctx.strokeStyle = "#9A5A1A";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, d / 2 - H.R * 0.03, Math.PI * 1.1, Math.PI * 1.45);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = H.R * 0.03;
  ctx.stroke();
}
