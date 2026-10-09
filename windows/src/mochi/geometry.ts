// Mochi's face and front-prop geometry, in body space: fractions of R, +y down,
// origin at the body centre. Pure numbers shared by BotEngine (which multiplies
// by R) and tests/geometry.test.ts, which checks a prop never covers the eyes.

/** Body half-height (BotEngine: ry = R * BODY_RY). */
export const BODY_RY = 0.88;

export const EYE_W = 0.25;
export const EYE_H = 0.27;
export const EYE_SP = 0.37;
export const EYE_P = -0.12;
/** Largest eye scale a reaction tweens to (the "surprised" pop). */
export const EYE_SCALE_MAX = 1.25;

/** Lowest point of the eyes at a head pitch (positive looks up) and eye scale. */
export function eyeBottom(pitch: number, es = 1): number {
  const p = EYE_P + pitch;
  const cp = Math.cos(p);
  // drawEyes: ey = -sin(p) * ry, the eye squashed vertically by max(0.18, cos p).
  return -Math.sin(p) * BODY_RY + ((EYE_H * es) / 2) * Math.max(0.18, cp);
}

// ── Messages envelope ─────────────────────────────────────────────────────────
// Held low in front of the body, so the open flap and the letter rising out of
// it stop below the eyes.

export const ENVELOPE = {
  /** Centre, below the body centre. */
  cy: BODY_RY,
  w: 0.9,
  h: 0.56,
  /** Rotation, radians. */
  tilt: -0.06,
  /** Open flap apex above the top edge, fraction of h. */
  flapRise: 0.45,
  /** Letter rise out of the pocket when fully open, fraction of h. */
  letterRise: 0.38,
  /** Letter size, fractions of w and h. */
  letterW: 0.72,
  letterH: 0.7,
  /** Heart sticker size on the closed flap. */
  heart: 0.13,
} as const;

export interface EnvelopeParts {
  /** Flap tip, envelope space (0 = envelope centre). */
  apex: number;
  /** Letter top edge once the flap is past half open, else null. */
  letterY: number | null;
  /** Heart sticker centre while the flap is still closed-side, else null. */
  heartY: number | null;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Where the moving parts are at `flap` (0 closed … 1 open). */
export function envelopeParts(flap: number): EnvelopeParts {
  const { h, flapRise, letterRise } = ENVELOPE;
  const apex = lerp(h * 0.08, -h / 2 - h * flapRise, flap);
  return {
    apex,
    letterY: flap > 0.5 ? -h / 2 - h * letterRise * ((flap - 0.5) * 2) : null,
    heartY: flap <= 0.5 ? apex - h * 0.06 : null,
  };
}

/** Highest point (smallest y) of the drawn envelope in body space, at pop scale `show`. */
export function envelopeTop(flap: number, show = 1): number {
  const { w, h, tilt, letterW, heart, cy } = ENVELOPE;
  const parts = envelopeParts(flap);
  const pts: [number, number][] = [[-w / 2, -h / 2], [w / 2, -h / 2], [0, parts.apex]];
  if (parts.letterY !== null) {
    pts.push([(-w * letterW) / 2, parts.letterY], [(w * letterW) / 2, parts.letterY]);
  }
  // heartPath's control points reach 0.95 × its size above the centre.
  if (parts.heartY !== null) pts.push([0, parts.heartY - heart * 0.95]);
  const sin = Math.sin(tilt);
  const cos = Math.cos(tilt);
  return cy + Math.min(...pts.map(([x, y]) => show * (x * sin + y * cos)));
}
