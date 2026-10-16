// The crown: a gold band with spikes all round the head. Its back half is
// drawn behind the head, darker; the front half in front, with gems.
// Part of ../outfits.ts, ported from upstream (Louis-CFM/coucou 23c09b9, c97dec1).

import { capClip, invert, proj, surf, type Ctx, type Head, type P3 } from "./head";
import { fillAll, lin, rad, type Stops } from "./paint";

const CROWN_S = 1.06;
/** Bottom and top of the band, as head heights. */
const CROWN_YB = 0.46;
const CROWN_YT = 0.66;
const CROWN_SPIKES = 8;
/** How far a spike rises above the band, in head units. */
const CROWN_SPIKE_H = 0.42;
/** Steps round the crown's outline. */
const CROWN_STEPS = 120;
/** A gem whose middle faces the viewer less than this is left out. */
const GEM_MIN_FACING = 0.12;
const GEMS = ["#EF4444", "#3B82F6", "#22C55E", "#A855F7"];
const GOLD_BACK: Stops = [[0, "#C98A12"], [1, "#8A5A06"]];
const GOLD_FRONT: Stops = [[0, "#FFE58A"], [0.5, "#FBBF24"], [1, "#D08A0B"]];

/** A step round the crown: on the band's lower edge (b), at the top of the spikes (tt). */
interface CrownPoint {
  b: P3;
  tt: P3;
  z: number;
}

/** The back half, behind the head. */
export function crownBack(ctx: Ctx, H: Head, simple: boolean) {
  crownPart(ctx, H, -1, simple);
}

/** The band's shadow on the head, then the front half. */
export function crownFront(ctx: Ctx, H: Head, body: Path2D, simple: boolean) {
  ctx.save();
  ctx.clip(body);
  ctx.clip(capClip(H, CROWN_YB - 0.1, 1));
  ctx.clip(invert(capClip(H, CROWN_YB, 1), H), "evenodd");
  ctx.fillStyle = "rgba(80,50,0,0.12)";
  fillAll(ctx, H);
  ctx.restore();
  crownPart(ctx, H, 1, simple);
}

/** side -1: the back half, behind the head; +1: the front half. */
function crownPart(ctx: Ctx, H: Head, side: number, simple: boolean) {
  const shape = crownShape(crownPoints(H), side);
  if (!shape) return;
  const dark = side < 0;
  ctx.fillStyle = lin(ctx, [0, -H.ry * 1.05, 0, -H.ry * 0.45], dark ? GOLD_BACK : GOLD_FRONT);
  ctx.fill(shape);
  if (dark) return;
  crownShine(ctx, H, shape);
  if (simple) return;
  for (let k = 0; k < CROWN_SPIKES; k++) crownJewels(ctx, H, k);
}

/** The band and the spike tops at every step round the head. */
function crownPoints(H: Head): CrownPoint[] {
  const s = CROWN_S;
  const n = CROWN_SPIKES;
  const N = CROWN_STEPS;
  const seg: CrownPoint[] = [];
  for (let i = 0; i <= N; i++) {
    const lon = -Math.PI + (i / N) * 2 * Math.PI;
    const b = proj(H, surf(CROWN_YB, lon, s));
    const phase = ((lon + Math.PI) / (2 * Math.PI)) * n;
    const f = phase - Math.floor(phase);
    const spike = Math.pow(Math.max(0, 1 - Math.abs(f - 0.5) * 2), 1.6);
    const sp = surf(CROWN_YT, lon, s);
    const tt = proj(H, [sp[0] * (1 - 0.08 * spike), CROWN_YT + CROWN_SPIKE_H * spike, sp[2] * (1 - 0.08 * spike)]);
    seg.push({ b, tt, z: b.z });
  }
  return seg;
}

/** The outline of one half: along the spike tops, back along the band. */
function crownShape(seg: CrownPoint[], side: number): Path2D | null {
  const keep = seg.filter((q) => (side > 0 ? q.z >= 0 : q.z < 0.02));
  if (keep.length < 2) return null;
  keep.sort((a, b) => a.b.x - b.b.x);
  const shape = new Path2D();
  keep.forEach((q, i) => (i ? shape.lineTo(q.tt.x, q.tt.y) : shape.moveTo(q.tt.x, q.tt.y)));
  for (let i = keep.length - 1; i >= 0; i--) shape.lineTo(keep[i].b.x, keep[i].b.y);
  shape.closePath();
  return shape;
}

/** Metal shading across the front half. */
function crownShine(ctx: Ctx, H: Head, shape: Path2D) {
  ctx.save();
  ctx.clip(shape);
  ctx.fillStyle = lin(ctx, [-H.rx, 0, H.rx, 0], [
    [0, "rgba(120,70,0,0.25)"], [0.45, "rgba(255,255,255,0)"],
    [0.62, "rgba(255,255,255,0.35)"], [1, "rgba(120,70,0,0.25)"],
  ]);
  ctx.fill(shape);
  ctx.restore();
}

/** Spike k's gold ball and the gem on the band below it, when facing the viewer. */
function crownJewels(ctx: Ctx, H: Head, k: number) {
  const lon = -Math.PI + ((k + 0.5) / CROWN_SPIKES) * 2 * Math.PI;
  const sp = surf(CROWN_YT, lon, CROWN_S);
  const tipP = proj(H, [sp[0] * 0.92, CROWN_YT + CROWN_SPIKE_H, sp[2] * 0.92]);
  const mid = proj(H, surf((CROWN_YB + CROWN_YT) / 2, lon, CROWN_S * 1.01));
  if (mid.z <= GEM_MIN_FACING) return;
  const r = H.R * 0.055;
  ctx.beginPath();
  ctx.arc(tipP.x, tipP.y - r * 0.5, r, 0, Math.PI * 2);
  ctx.fillStyle = rad(ctx, [tipP.x - r * 0.3, tipP.y - r, 0, r * 1.2], [[0, "#FFF6CC"], [1, "#E0A21A"]]);
  ctx.fill();
  const gr = H.R * 0.075;
  ctx.beginPath();
  ctx.ellipse(mid.x, mid.y, gr * Math.max(0.35, mid.z), gr, 0, 0, Math.PI * 2);
  ctx.fillStyle = GEMS[k % GEMS.length];
  ctx.fill();
  ctx.beginPath();
  ctx.arc(mid.x - gr * 0.25 * mid.z, mid.y - gr * 0.35, gr * 0.28, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.fill();
}
