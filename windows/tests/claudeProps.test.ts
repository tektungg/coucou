// Claude Code act props (mochi/claudeProps.ts): every prop, at every moment of
// its animation, stays inside the island's bot canvas and off Mochi's eyes.
// A canvas stub records each filled or stroked shape's bounding box through the
// current transform. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_PROPS, PROP_SCALE, drawClaudeProp } from "../src/mochi/claudeProps.ts";
import { BODY_RY, EYE_H, EYE_SCALE_MAX, EYE_SP, EYE_W, eyeBottom } from "../src/mochi/geometry.ts";

type M = [number, number, number, number, number, number];
interface Box { x0: number; y0: number; x1: number; y1: number }

/** Just enough of CanvasRenderingContext2D to replay a prop and measure it. */
class BoundsCtx {
  shapes: Box[] = [];
  private m: M = [1, 0, 0, 1, 0, 0];
  private stack: M[] = [];
  private path: [number, number][] = [];
  lineWidth = 1;
  font = "10px sans-serif";
  fillStyle: unknown = "";
  strokeStyle: unknown = "";
  globalAlpha = 1;
  lineCap = ""; lineJoin = ""; textAlign = ""; textBaseline = "";
  shadowColor = ""; shadowBlur = 0; shadowOffsetX = 0; shadowOffsetY = 0;

  private pt(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.m;
    return [a * x + c * y + e, b * x + d * y + f];
  }
  private add(x: number, y: number) { this.path.push(this.pt(x, y)); }
  private addBox(x0: number, y0: number, x1: number, y1: number) {
    this.add(x0, y0); this.add(x1, y0); this.add(x0, y1); this.add(x1, y1);
  }
  private record(pad = 0) {
    if (this.path.length === 0) return;
    const xs = this.path.map((p) => p[0]), ys = this.path.map((p) => p[1]);
    this.shapes.push({ x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad });
  }
  save() { this.stack.push([...this.m]); }
  restore() { this.m = this.stack.pop() ?? [1, 0, 0, 1, 0, 0]; }
  translate(x: number, y: number) { const [a, b, c, d, e, f] = this.m; this.m = [a, b, c, d, a * x + c * y + e, b * x + d * y + f]; }
  scale(sx: number, sy: number) { const [a, b, c, d, e, f] = this.m; this.m = [a * sx, b * sx, c * sy, d * sy, e, f]; }
  rotate(r: number) {
    const [a, b, c, d, e, f] = this.m, cos = Math.cos(r), sin = Math.sin(r);
    this.m = [a * cos + c * sin, b * cos + d * sin, c * cos - a * sin, d * cos - b * sin, e, f];
  }
  beginPath() { this.path = []; }
  closePath() {}
  moveTo(x: number, y: number) { this.add(x, y); }
  lineTo(x: number, y: number) { this.add(x, y); }
  /** Exact box of an ellipse (or circle) through the current transform. */
  private addEllipse(x: number, y: number, rx: number, ry: number, rot = 0) {
    const [a, b, c, d] = this.m, cos = Math.cos(rot), sin = Math.sin(rot);
    const u = [rx * cos, rx * sin], v = [-ry * sin, ry * cos];
    const ux = a * u[0] + c * u[1], uy = b * u[0] + d * u[1];
    const vx = a * v[0] + c * v[1], vy = b * v[0] + d * v[1];
    const [cx, cy] = this.pt(x, y);
    const hx = Math.hypot(ux, vx), hy = Math.hypot(uy, vy);
    this.path.push([cx - hx, cy - hy], [cx + hx, cy + hy]);
  }
  arc(x: number, y: number, r: number) { this.addEllipse(x, y, r, r); }
  ellipse(x: number, y: number, rx: number, ry: number, rot = 0) { this.addEllipse(x, y, rx, ry, rot); }
  arcTo(x1: number, y1: number, x2: number, y2: number) { this.add(x1, y1); this.add(x2, y2); }
  /** Control points and end point, as the canvas API passes them (cp1x, cp1y, cp2x, cp2y, x, y). */
  bezierCurveTo(...p: number[]) { for (let i = 0; i < p.length; i += 2) this.add(p[i], p[i + 1]); }
  quadraticCurveTo(a: number, b: number, x: number, y: number) { this.add(a, b); this.add(x, y); }
  fill() { this.record(); }
  stroke() { this.record(this.lineWidth / 2); }
  clip() {}
  fillRect(x: number, y: number, w: number, h: number) { this.beginPath(); this.addBox(x, y, x + w, y + h); this.record(); }
  private fontPx() { return Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 10); }
  measureText(s: string) { return { width: s.length * this.fontPx() * 0.6 }; }
  fillText(s: string, x: number, y: number) {
    const w = this.measureText(s).width, h = this.fontPx();
    this.beginPath();
    this.addBox(x - w, y - h, x + w, y + h); // generous: alignment varies
    this.record();
  }
  strokeText(s: string, x: number, y: number) { this.fillText(s, x, y); }
  createLinearGradient() { return { addColorStop() {} }; }
  createRadialGradient() { return { addColorStop() {} }; }
}

// The island's Mochi: R in px for the smallest and largest bot of the views.
const R = 30;
const scene = (t: number) => ({ R: R * PROP_SCALE, rx: R * 1.14, ry: R * BODY_RY, t });

// The bot canvas is diameter / 0.6 wide (island.ts) and R = 0.3 × that width,
// so it reaches 1/0.6 R to each side. Above, it has more than 2.9 R in every view.
const HALF_WIDTH = R / 0.6;
const TOP = -2.9 * R;
const BOTTOM = 1.6 * R;
/** Confetti and steam may drift out and be clipped, like the engine's particles. */
const PARTICLE = (0.15 * R) ** 2;

const eyeX = Math.sin(EYE_SP) * 1.14 * R;
const eyeHalfW = ((EYE_W * EYE_SCALE_MAX) / 2) * R;
const eyeTop = (Math.sin(0.12) * BODY_RY - (EYE_H * EYE_SCALE_MAX) / 2) * R;
const eyeBot = eyeBottom(0, EYE_SCALE_MAX) * R;
const EYES: Box[] = [-1, 1].map((sd) => ({ x0: sd * eyeX - eyeHalfW, x1: sd * eyeX + eyeHalfW, y0: eyeTop, y1: eyeBot }));
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

function replay(key: string): { t: number; box: Box }[] {
  const [name, ...rest] = key.split(":");
  const out: { t: number; box: Box }[] = [];
  for (let t = 0; t <= 8.4; t += 0.1) {
    const x = new BoundsCtx();
    drawClaudeProp(x as unknown as CanvasRenderingContext2D, scene(t), name, rest.join(":"));
    for (const box of x.shapes) out.push({ t, box });
  }
  return out;
}

for (const key of Object.keys(CLAUDE_PROPS)) {
  test(`${key}: draws something, inside the bot canvas`, () => {
    const shapes = replay(key);
    assert.ok(shapes.length > 0, "the prop draws");
    for (const { t, box } of shapes) {
      if ((box.x1 - box.x0) * (box.y1 - box.y0) < PARTICLE) continue;
      const where = `t=${t.toFixed(1)} box x ${(box.x0 / R).toFixed(2)}..${(box.x1 / R).toFixed(2)} R, y ${(box.y0 / R).toFixed(2)}..${(box.y1 / R).toFixed(2)} R`;
      assert.ok(box.x0 >= -HALF_WIDTH && box.x1 <= HALF_WIDTH, `${key} leaves the canvas sideways: ${where}`);
      assert.ok(box.y0 >= TOP && box.y1 <= BOTTOM, `${key} leaves the canvas vertically: ${where}`);
    }
  });

  test(`${key}: never covers the eyes`, () => {
    for (const { t, box } of replay(key)) {
      assert.ok(!EYES.some((e) => overlaps(box, e)),
        `${key} covers an eye at t=${t.toFixed(1)}: x ${(box.x0 / R).toFixed(2)}..${(box.x1 / R).toFixed(2)} R, y ${(box.y0 / R).toFixed(2)}..${(box.y1 / R).toFixed(2)} R`);
    }
  });
}

test("an unknown variant draws nothing", () => {
  const x = new BoundsCtx();
  drawClaudeProp(x as unknown as CanvasRenderingContext2D, scene(0), "claude", "finished");
  drawClaudeProp(x as unknown as CanvasRenderingContext2D, scene(0), "claude", null);
  assert.equal(x.shapes.length, 0);
});
