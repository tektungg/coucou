// Mochi's head as the outfits see it: the superellipsoid, its projection into
// body space, the rings and caps a hat sits on, and where the eyes are drawn.
// Part of ../outfits.ts, ported from upstream (Louis-CFM/coucou 23c09b9, c97dec1).

const EXP = 2.7;
const VIEW_TILT = -0.3;
const ACC_PITCH = 0.4;
const EYE_W = 0.25;
const EYE_H = 0.27;
const EYE_SP = 0.37;
const EYE_P = -0.12;
/** An eye that faces the viewer less than this is hidden. */
const EYE_VISIBLE_MIN = 0.04;
/** An eye never squashes narrower than this when Mochi turns or tilts. */
const EYE_MIN_SQUASH = 0.18;
/** Points on the body outline. */
const OUTLINE_STEPS = 96;
/** Points on a ring round the head. */
const RING_STEPS = 120;

/** Below this radius the small details (ribs, dots, gems) are left out. */
export const SIMPLIFY_BELOW_R = 16;

export type Ctx = CanvasRenderingContext2D;
export type Vec3 = readonly [number, number, number];
export interface P3 { x: number; y: number; z: number }
export interface Pt { x: number; y: number }

/** Head geometry + the spring lag of the soft parts (-1…1, in head units). */
export interface Head {
  R: number;
  rx: number;
  ry: number;
  yaw: number;
  pitch: number;
  physDx: number;
  physDy: number;
}

export function makeHead(R: number, yaw = 0, pitch = 0, physDx = 0, physDy = 0): Head {
  return { R, rx: R * 1.14, ry: R * 0.88, yaw, pitch, physDx, physDy };
}

// ── 3D helpers ────────────────────────────────────────────────────────────────

/** Radius of the horizontal ring of the head at height y. */
export function ringR(y: number): number {
  const a = Math.min(1, Math.abs(y));
  return Math.pow(1 - Math.pow(a, EXP), 1 / EXP);
}

/** Head-local point (x right, y up, z toward the viewer) → body space, with depth. */
export function proj(H: Head, p: Vec3): P3 {
  const [x, y, z] = p;
  const cy = Math.cos(H.yaw);
  const sy = Math.sin(H.yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const pitch = VIEW_TILT + H.pitch * ACC_PITCH;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y2 = y * cp + z1 * sp;
  const z2 = -y * sp + z1 * cp;
  return { x: x1 * H.rx, y: -y2 * H.ry, z: z2 };
}

/** Point on the head surface at height y, longitude lon (0 = facing the viewer), scaled by s. */
export function surf(y: number, lon: number, s = 1): Vec3 {
  const r = ringR(y) * s;
  return [r * Math.sin(lon), y, r * Math.cos(lon)];
}

/** The visible half of a projected closed ring, left → right, cut at its silhouette. */
export function frontSilhouette(pts: P3[]): P3[] {
  const n = pts.length;
  if (n < 2) return pts;
  let minI = 0;
  let maxI = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i].x < pts[minI].x) minI = i;
    if (pts[i].x > pts[maxI].x) maxI = i;
  }
  if (minI === maxI) return [pts[minI]];
  const walk = (step: number) => {
    const out: P3[] = [];
    let i = minI;
    for (;;) {
      out.push(pts[i]);
      if (i === maxI || out.length > n) break;
      i = (i + step + n) % n;
    }
    return out;
  };
  const a = walk(1);
  const b = walk(-1);
  const za = a.reduce((s, q) => s + q.z, 0) / a.length;
  const zb = b.reduce((s, q) => s + q.z, 0) / b.length;
  return za >= zb ? a : b;
}

function ring(H: Head, y: number, s: number, n = RING_STEPS): P3[] {
  const pts: P3[] = [];
  for (let i = 0; i < n; i++) pts.push(proj(H, surf(y, -Math.PI + (i / n) * 2 * Math.PI, s)));
  return pts;
}

/** Front arc of the ring at height y, ordered left → right. */
export function frontArc(H: Head, y: number, s: number): P3[] {
  return frontSilhouette(ring(H, y, s));
}

/** A line of longitude on the head, from height y0 up by span, cut in `steps`, at scale s. */
export interface Meridian {
  lon: number;
  s: number;
  y0: number;
  span: number;
  steps: number;
}

/** The points of a meridian that face the viewer (knit ribs, pumpkin ribs). */
export function visibleMeridian(H: Head, m: Meridian): P3[] {
  const pts: P3[] = [];
  for (let i = 0; i <= m.steps; i++) {
    const q = proj(H, surf(m.y0 + (m.span * i) / m.steps, m.lon, m.s));
    if (q.z > 0) pts.push(q);
  }
  return pts;
}

/** The part of the head above the front arc of ring y: what a cap covers. */
export function capClip(H: Head, y: number, s: number, extraTop = 3): Path2D {
  const arc = frontArc(H, y, s);
  const p = new Path2D();
  if (arc.length === 0) return p;
  p.moveTo(arc[0].x - H.rx, arc[0].y);
  for (const q of arc) p.lineTo(q.x, q.y);
  const last = arc[arc.length - 1];
  p.lineTo(last.x + H.rx, last.y);
  p.lineTo(H.rx * 2, -H.ry * extraTop);
  p.lineTo(-H.rx * 2, -H.ry * extraTop);
  p.closePath();
  return p;
}

/** Everything but `p`, for an even-odd clip. */
export function invert(p: Path2D, H: Head): Path2D {
  const q = new Path2D();
  q.rect(-H.rx * 4, -H.ry * 4, H.rx * 8, H.ry * 8);
  q.addPath(p);
  return q;
}

/** Mochi's body outline, same superellipse as the engine. */
export function bodyOutline(rx: number, ry: number): Path2D {
  const p = new Path2D();
  const n = OUTLINE_STEPS;
  const e = 2 / EXP;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const x = rx * Math.sign(ca) * Math.pow(Math.abs(ca), e);
    const y = ry * Math.sign(sa) * Math.pow(Math.abs(sa), e);
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

/** True once the head has turned far enough that its face points away. */
export function faceTurnedAway(H: Head): boolean {
  return proj(H, [0, 0, 1]).z < 0;
}

// ── Eyes ──────────────────────────────────────────────────────────────────────

export interface EyeFrame {
  sd: number;
  x: number;
  y: number;
  fx: number;
  fy: number;
  visible: boolean;
  w: number;
  h: number;
}

/** Where the engine draws the eyes: the glasses sit on these. */
export function eyeFrames(H: Head): EyeFrame[] {
  return [-1, 1].map((sd) => {
    const eyeYaw = sd * EYE_SP + H.yaw;
    const eyePitch = EYE_P + H.pitch;
    const cp = Math.cos(eyePitch);
    return {
      sd,
      visible: Math.cos(eyeYaw) * cp > EYE_VISIBLE_MIN,
      x: Math.sin(eyeYaw) * cp * H.rx,
      y: -Math.sin(eyePitch) * H.ry,
      fx: Math.max(EYE_MIN_SQUASH, Math.cos(eyeYaw)),
      fy: Math.max(EYE_MIN_SQUASH, cp),
      w: H.R * EYE_W,
      h: H.R * EYE_H,
    };
  });
}
