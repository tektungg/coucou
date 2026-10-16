// Small Canvas helpers shared by every outfit: gradients, paths, rounded
// rectangles and the soft shadow a hat casts on the head.
// Part of ../outfits.ts, ported from upstream (Louis-CFM/coucou 23c09b9, c97dec1).

import { capClip, type Ctx, type Head, type Pt } from "./head";

/** Colour stops of a gradient: offset 0…1, CSS colour. */
export type Stops = [number, string][];
/** A linear gradient's axis, from (x0, y0) to (x1, y1). */
export type LinearAxis = readonly [x0: number, y0: number, x1: number, y1: number];
/** A radial gradient: centre (x, y), inner radius r0, outer radius r1. */
export type RadialSpec = readonly [x: number, y: number, r0: number, r1: number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Canvas refuses a radial gradient with a zero outer radius. */
const MIN_RADIUS = 0.001;

export function lin(ctx: Ctx, axis: LinearAxis, stops: Stops) {
  const [x0, y0, x1, y1] = axis;
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

export function rad(ctx: Ctx, spec: RadialSpec, stops: Stops) {
  const [x, y, r0, r1] = spec;
  const g = ctx.createRadialGradient(x, y, r0, x, y, Math.max(MIN_RADIUS, r1));
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

export function polyline(ctx: Ctx, pts: Pt[]) {
  ctx.beginPath();
  pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
}

/** A closed path through `pts`. */
export function closedPath(pts: Pt[]): Path2D {
  const p = new Path2D();
  pts.forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y)));
  p.closePath();
  return p;
}

/** Starts a new path: `rect` with its corners rounded by r (clamped to fit). */
export function roundRect(ctx: Ctx, rect: Rect, r: number) {
  const { x, y, w, h } = rect;
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** A big rectangle: fills whatever the current clip lets through. */
export function fillAll(ctx: Ctx, H: Head) {
  ctx.fillRect(-H.rx * 4, -H.ry * 4, H.rx * 8, H.ry * 8);
}

/** The shadow a hat casts on the head: the body above ring y, tinted `color`. */
export function capShadow(ctx: Ctx, H: Head, body: Path2D, y: number, color: string) {
  ctx.save();
  ctx.clip(body);
  ctx.clip(capClip(H, y, 1));
  ctx.fillStyle = color;
  fillAll(ctx, H);
  ctx.restore();
}
