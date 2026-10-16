// Shapes and inks Mochi's engine and its drawing modules share. Split out of
// engine.ts (BotEngine.swift port), unchanged.

import { lerp } from "../core/anim";
import type { RGB } from "./engine";

/** The engine's clock, in seconds. */
export const now = () => performance.now() / 1000;

export const rgba = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

export const mix3 = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t),
];

export const BASE_TOP: RGB = [0.929, 0.929, 0.937]; // #EDEDEF
export const BASE_BOTTOM: RGB = [0.769, 0.773, 0.792]; // #C4C5CA
export const INK = "rgb(26,20,18)"; // #1A1412
export const MINI_INK = "rgb(16,19,26)"; // #10131A
export const GRAPHITE = "rgb(54,58,69)"; // act props: headband, boom mic

/** Body radius at or below which Mochi is at compact/peek size, too small for fine detail. */
export const COMPACT_R = 14;

/** An axis-aligned rectangle: top-left corner, width and height. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Mochi's body size: R (the drawing unit) and the body's two half-axes. */
export interface BodyDims {
  R: number;
  rx: number;
  ry: number;
}

/** Starts a new path tracing `rect` with corners of radius `R` (clamped to fit). */
export function roundRectPath(x: CanvasRenderingContext2D, rect: Rect, R: number) {
  const { x: X, y: Y, w: W, h: H } = rect;
  const r = Math.max(0, Math.min(R, W / 2, H / 2));
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r);
  x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r);
  x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

export function heartPath(x: CanvasRenderingContext2D, s: number) {
  x.beginPath();
  x.moveTo(0, s * 0.38);
  x.bezierCurveTo(-s * 1.05, -s * 0.15, -s * 0.5, -s * 0.95, 0, -s * 0.38);
  x.bezierCurveTo(s * 0.5, -s * 0.95, s * 1.05, -s * 0.15, 0, s * 0.38);
  x.closePath();
}

export function starPath(x: CanvasRenderingContext2D, ro: number, ri: number) {
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    x.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  x.closePath();
}

export const FONT = `system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif`;

/** Ray → rounded-rect boundary intersection, for the mailbox morph. */
export function rrPoint(ca: number, sa: number, W: number, H: number, cr: number): { x: number; y: number } {
  const eps = 1e-6;
  const kx = ca >= 0 ? 1 : -1;
  const ky = sa >= 0 ? 1 : -1;
  const cx = kx * (W - cr);
  const cy = ky * (H - cr);

  const dot = ca * cx + sa * cy;
  const disc = dot * dot - (cx * cx + cy * cy - cr * cr);
  if (disc >= 0) {
    const t = dot + Math.sqrt(disc);
    if (t > eps) {
      const px = ca * t;
      const py = sa * t;
      if (Math.abs(px) >= W - cr - eps && Math.abs(py) >= H - cr - eps) return { x: px, y: py };
    }
  }
  if (Math.abs(sa) > eps) {
    const t = (ky * H) / sa;
    if (t > eps) {
      const px = ca * t;
      if (Math.abs(px) <= W - cr + eps) return { x: px, y: ky * H };
    }
  }
  if (Math.abs(ca) > eps) {
    const t = (kx * W) / ca;
    if (t > eps) {
      const py = sa * t;
      if (Math.abs(py) <= H - cr + eps) return { x: kx * W, y: py };
    }
  }
  return { x: kx * W, y: ky * H };
}
