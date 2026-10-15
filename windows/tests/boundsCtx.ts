// A canvas stub for the prop tests (claudeProps, musicProps): it records each
// filled or stroked shape's bounding box through the current transform.

type M = [number, number, number, number, number, number];
export interface Box { x0: number; y0: number; x1: number; y1: number }

/** Just enough of CanvasRenderingContext2D to replay a prop and measure it. */
export class BoundsCtx {
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

