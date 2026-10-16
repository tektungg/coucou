// What Mochi wears on his face and head besides hats and glasses: the scarf,
// the pumpkin (its body colours come from the engine), the bow and the bunny
// ears (always behind the head).
// Part of ../outfits.ts, ported from upstream (Louis-CFM/coucou 23c09b9, c97dec1).

import { bodyOutline, frontArc, proj, surf, visibleMeridian, type Ctx, type Head, type P3 } from "./head";
import { lin, polyline, rad } from "./paint";

// ── Scarf ─────────────────────────────────────────────────────────────────────

const SCARF_S = 1.05;
/** Top and bottom of the band, as head heights. */
const SCARF_TOP = -0.34;
const SCARF_BOTTOM = -0.66;
/** Longitudes of the white stripes round the band. */
const SCARF_STRIPES = [-1.0, -0.45, 0.1, 0.65, 1.2];
/** The stripes run this many px past the band's edges, hidden by the clip. */
const STRIPE_OVERSHOOT = 4;
const FRINGE_THREADS = 4;

export function scarf(ctx: Ctx, H: Head) {
  const s = SCARF_S;
  const top = frontArc(H, SCARF_TOP, s);
  const bot = frontArc(H, SCARF_BOTTOM, s);
  if (top.length === 0 || bot.length === 0) return;
  const band = scarfBand(top, bot);

  ctx.save();
  ctx.clip(bodyOutline(H.rx * s, H.ry * s));
  ctx.fillStyle = lin(ctx, [0, -H.ry * 0.2, 0, H.ry * 0.7], [[0, "#F87171"], [1, "#B91C1C"]]);
  ctx.fill(band);
  scarfStripes(ctx, H, band);
  ctx.fillStyle = lin(ctx, [0, -H.ry * 0.5, 0, H.ry * 0.3], [[0, "rgba(255,255,255,0.18)"], [1, "rgba(0,0,0,0.1)"]]);
  ctx.fill(band);
  ctx.restore();

  // the hanging end, from the knot
  const k = proj(H, surf((SCARF_TOP + SCARF_BOTTOM) / 2, -0.55, s * 1.03));
  if (k.z <= 0) return;
  scarfEnd(ctx, H, k);
  scarfKnot(ctx, H, k);
}

/** The band round the neck: along its top arc, back along its bottom one. */
function scarfBand(top: P3[], bot: P3[]): Path2D {
  const band = new Path2D();
  top.forEach((q, i) => (i ? band.lineTo(q.x, q.y) : band.moveTo(q.x, q.y)));
  for (let i = bot.length - 1; i >= 0; i--) band.lineTo(bot[i].x, bot[i].y);
  band.closePath();
  return band;
}

/** White stripes across the band, thinner as they turn away. */
function scarfStripes(ctx: Ctx, H: Head, band: Path2D) {
  ctx.save();
  ctx.clip(band);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineCap = "round";
  for (const lon of SCARF_STRIPES) {
    const a = proj(H, surf(SCARF_TOP, lon, SCARF_S));
    const b = proj(H, surf(SCARF_BOTTOM, lon, SCARF_S));
    if (a.z < 0) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - STRIPE_OVERSHOOT);
    ctx.lineTo(b.x, b.y + STRIPE_OVERSHOOT);
    ctx.lineWidth = H.R * 0.09 * Math.max(0.3, a.z);
    ctx.stroke();
  }
  ctx.restore();
}

/** The end hanging from the knot at k, swinging with the spring lag. */
function scarfEnd(ctx: Ctx, H: Head, k: P3) {
  const sw = H.physDx * H.rx * 0.12;
  const end = new Path2D();
  end.moveTo(k.x - H.R * 0.16, k.y);
  end.quadraticCurveTo(k.x - H.R * 0.24 + sw, k.y + H.ry * 0.35, k.x - H.R * 0.2 + sw * 1.4, k.y + H.ry * 0.62);
  end.lineTo(k.x + H.R * 0.06 + sw * 1.4, k.y + H.ry * 0.6);
  end.quadraticCurveTo(k.x + H.R * 0.02 + sw, k.y + H.ry * 0.3, k.x + H.R * 0.12, k.y);
  end.closePath();
  ctx.fillStyle = lin(ctx, [0, k.y, 0, k.y + H.ry * 0.6], [[0, "#EF4444"], [1, "#B91C1C"]]);
  ctx.fill(end);
  ctx.save();
  ctx.clip(end);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  for (const t of [0.35, 0.7]) ctx.fillRect(k.x - H.R * 0.4 + sw, k.y + H.ry * 0.62 * t, H.R * 0.8, H.R * 0.07);
  ctx.restore();
  scarfFringe(ctx, H, k, sw);
}

/** The threads at the bottom of the hanging end. */
function scarfFringe(ctx: Ctx, H: Head, k: P3, sw: number) {
  ctx.strokeStyle = "#DC2626";
  ctx.lineWidth = H.R * 0.035;
  ctx.lineCap = "round";
  for (let i = 0; i < FRINGE_THREADS; i++) {
    const fx = k.x - H.R * 0.17 + sw * 1.4 + i * H.R * 0.075;
    ctx.beginPath();
    ctx.moveTo(fx, k.y + H.ry * 0.6);
    ctx.lineTo(fx, k.y + H.ry * 0.72);
    ctx.stroke();
  }
}

function scarfKnot(ctx: Ctx, H: Head, k: P3) {
  ctx.beginPath();
  ctx.ellipse(k.x, k.y, H.R * 0.17, H.R * 0.14, 0.2, 0, Math.PI * 2);
  ctx.fillStyle = rad(ctx, [k.x - H.R * 0.05, k.y - H.R * 0.05, 0, H.R * 0.2], [[0, "#F87171"], [1, "#B91C1C"]]);
  ctx.fill();
}

// ── Pumpkin ───────────────────────────────────────────────────────────────────

/** The body's top and bottom colours while Mochi is a pumpkin; the engine paints them. */
export const PUMPKIN_BODY: readonly [string, string] = ["#FFA94D", "#E8590C"];
/** Longitudes of the ribs. */
const PUMPKIN_RIBS = [-1.15, -0.55, 0.0, 0.55, 1.15];
const PUMPKIN_RIB_STEPS = 30;

export function pumpkin(ctx: Ctx, H: Head, body: Path2D, simple: boolean) {
  if (!simple) pumpkinRibs(ctx, H, body);
  const t = proj(H, [0.02, 1.0, 0]);
  pumpkinStem(ctx, H, t);
  pumpkinLeaf(ctx, H, t);
  if (simple) return;
  pumpkinTendril(ctx, H, t);
}

/** Ribs from the bottom to the top of the body, each a groove with a light beside it. */
function pumpkinRibs(ctx: Ctx, H: Head, body: Path2D) {
  ctx.save();
  ctx.clip(body);
  ctx.lineCap = "round";
  for (const lon of PUMPKIN_RIBS) {
    const pts = visibleMeridian(H, { lon, s: 1, y0: -0.98, span: 1.96, steps: PUMPKIN_RIB_STEPS });
    if (pts.length < 2) continue;
    const zz = pts[Math.floor(pts.length / 2)].z;
    polyline(ctx, pts);
    ctx.strokeStyle = `rgba(150,50,0,${0.22 * zz})`;
    ctx.lineWidth = H.R * 0.12;
    ctx.stroke();
    polyline(ctx, pts.map((q) => ({ x: q.x + H.R * 0.07, y: q.y })));
    ctx.strokeStyle = `rgba(255,220,170,${0.18 * zz})`;
    ctx.lineWidth = H.R * 0.04;
    ctx.stroke();
  }
  ctx.restore();
}

/** The stem, standing on the top of the head at t. */
function pumpkinStem(ctx: Ctx, H: Head, t: P3) {
  ctx.beginPath();
  ctx.moveTo(t.x - H.R * 0.09, t.y + H.R * 0.04);
  ctx.quadraticCurveTo(t.x - H.R * 0.08, t.y - H.R * 0.22, t.x + H.R * 0.08, t.y - H.R * 0.3);
  ctx.lineTo(t.x + H.R * 0.13, t.y - H.R * 0.22);
  ctx.quadraticCurveTo(t.x + H.R * 0.04, t.y - H.R * 0.15, t.x + H.R * 0.08, t.y + H.R * 0.04);
  ctx.closePath();
  ctx.fillStyle = lin(ctx, [t.x - H.R * 0.1, 0, t.x + H.R * 0.1, 0], [[0, "#65A30D"], [1, "#3F6212"]]);
  ctx.fill();
}

/** A leaf at the stem's foot, with its vein. */
function pumpkinLeaf(ctx: Ctx, H: Head, t: P3) {
  ctx.save();
  ctx.translate(t.x - H.R * 0.06, t.y - H.R * 0.02);
  ctx.rotate(-0.5);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-H.R * 0.18, -H.R * 0.2, -H.R * 0.38, -H.R * 0.02);
  ctx.quadraticCurveTo(-H.R * 0.18, H.R * 0.1, 0, 0);
  ctx.fillStyle = lin(ctx, [0, -H.R * 0.15, -H.R * 0.3, 0], [[0, "#84CC16"], [1, "#4D7C0F"]]);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-H.R * 0.02, -H.R * 0.01);
  ctx.quadraticCurveTo(-H.R * 0.18, -H.R * 0.08, -H.R * 0.32, -H.R * 0.03);
  ctx.strokeStyle = "rgba(30,60,0,0.4)";
  ctx.lineWidth = H.R * 0.02;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}

/** A curly tendril off the stem. */
function pumpkinTendril(ctx: Ctx, H: Head, t: P3) {
  ctx.beginPath();
  ctx.moveTo(t.x + H.R * 0.1, t.y - H.R * 0.12);
  ctx.bezierCurveTo(t.x + H.R * 0.3, t.y - H.R * 0.25, t.x + H.R * 0.35, t.y - H.R * 0.02, t.x + H.R * 0.22, t.y - H.R * 0.06);
  ctx.strokeStyle = "#4D7C0F";
  ctx.lineWidth = H.R * 0.03;
  ctx.lineCap = "round";
  ctx.stroke();
}

// ── Bow (anchored in 3D, turns with the head) ─────────────────────────────────

/** Past this depth the bow is behind the head and not drawn. */
const BOW_HIDDEN_Z = -0.2;

export function bow(ctx: Ctx, H: Head) {
  const a = proj(H, surf(0.86, 0.55, 1.02));
  if (a.z < BOW_HIDDEN_Z) return;
  const s = H.R * 0.26;
  const sq = Math.max(0.45, Math.cos(0.55 + H.yaw));
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.rotate(0.35 + H.yaw * 0.3);
  ctx.scale(sq, 1);
  for (const sd of [-1, 1]) bowLoop(ctx, s, sd);
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.24, s * 0.3, 0, 0, Math.PI * 2);
  ctx.fillStyle = rad(ctx, [-s * 0.06, -s * 0.1, 0, s * 0.35], [[0, "#FFB3D9"], [1, "#C2185B"]]);
  ctx.fill();
  ctx.restore();
}

/** One loop of the bow, of size s, on side sd (-1 left, +1 right), with its fold. */
function bowLoop(ctx: Ctx, s: number, sd: number) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(sd * s * 0.6, -s * 0.85, sd * s * 1.35, -s * 0.55, sd * s * 1.15, 0);
  ctx.bezierCurveTo(sd * s * 1.35, s * 0.55, sd * s * 0.6, s * 0.85, 0, 0);
  ctx.fillStyle = lin(ctx, [0, -s, 0, s], [[0, "#FF8CC6"], [1, "#DB2777"]]);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(sd * s * 0.25, -s * 0.05);
  ctx.quadraticCurveTo(sd * s * 0.7, -s * 0.15, sd * s * 0.95, -s * 0.05);
  ctx.strokeStyle = "rgba(140,10,70,0.35)";
  ctx.lineWidth = s * 0.08;
  ctx.lineCap = "round";
  ctx.stroke();
}

// ── Bunny ears (always behind the head) ───────────────────────────────────────

export function bunnyEars(ctx: Ctx, H: Head) {
  const R = H.R;
  const earH = R * 0.85;
  for (const sd of [-1, 1]) {
    const root = proj(H, [sd * 0.45, 0.92, 0]);
    const rootL = proj(H, [sd * 0.45 - 0.22, 0.92, 0]);
    const rootR = proj(H, [sd * 0.45 + 0.22, 0.92, 0]);
    const hw = Math.max(R * 0.04, Math.abs(rootR.x - rootL.x) / 2);
    ctx.save();
    ctx.translate(root.x, root.y - earH * 0.15);
    ctx.beginPath();
    ctx.ellipse(0, 0, hw, earH / 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#F9F0F0";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.06)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, -earH / 2 + R * 0.1 + earH * 0.325, hw * 0.5, earH * 0.325, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(252,165,165,0.7)";
    ctx.fill();
    ctx.restore();
  }
}
