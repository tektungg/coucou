// Mochi's acts: a themed animation per personal pill, played only on a real
// event (Music playing, the mic in use, a new message, a new file on the shelf,
// a Space item done). Everything here is a pure function of the pill data and
// of time, so it is tested in tests/acts.test.ts; BotEngine fades the pose in
// and out, adds it on top of its own animation and draws the props.

import type { AgentTask } from "../core/state";
import type { EyeShape } from "./engine";

export type ActName = "dance" | "mic" | "mail" | "catch" | "check";

/** What a pill is playing. `at` is performance.now() ms of the event (0 for continuous acts). */
export interface Act {
  name: ActName;
  variant: string | null;
  at: number;
}

export interface Pose {
  /** Vertical / horizontal offset, fraction of R (negative oy = up). */
  oy: number;
  ox: number;
  /** Body rotation, radians. */
  tilt: number;
  /** Head turn and nod added to the look direction. */
  yaw: number;
  pitch: number;
  /** Scale multipliers (1 = none). */
  sx: number;
  sy: number;
  /** How far each hand is raised, 0…1. */
  handL: number;
  handR: number;
}

export const NEUTRAL: Pose = { oy: 0, ox: 0, tilt: 0, yaw: 0, pitch: 0, sx: 1, sy: 1, handL: 0, handR: 0 };

export const AUDIO_PILL_ID = "integration_audio";
export const MESSAGES_PILL_ID = "integration_messages";
export const SHELF_PILL_ID = "integration_shelf";
export const SPACE_PILL_ID = "integration_space";

/** One-shot lengths. Continuous acts (dance, mic) last as long as their trigger. */
export function actDurationMs(name: ActName, variant: string | null): number {
  switch (name) {
    case "mail": return 3200;
    case "catch": return 2600;
    case "check": return variant === "all" ? 3600 : 2800;
    default: return Number.POSITIVE_INFINITY;
  }
}

/** One-shots play once from `at`; continuous acts follow the engine's free clock. */
export const isOneShot = (name: ActName) => Number.isFinite(actDurationMs(name, null));

/** Acts whose hands come out from behind the body. */
export const ACT_HANDS: ReadonlySet<ActName> = new Set<ActName>(["dance", "mail", "check"]);

// ── Music groove ─────────────────────────────────────────────────────────────
// While the Music pill plays, Mochi wears headphones and dances.

/** Fixed tempo. The real track BPM is not available (Spotify closed audio features). */
export const DANCE_BPM = 112;
export const BEAT = 60 / DANCE_BPM;

export const MEDIA_PILL_ID = "integration_media";

/**
 * The Music pill goes `working` while something plays (island/integrations.ts),
 * so a paused track or an event card (finished/error) stops the dance.
 */
export function isDancing(task: Pick<AgentTask, "id" | "state"> | null | undefined): boolean {
  return task != null && task.id === MEDIA_PILL_ID && task.state === "working";
}

export interface DancePose {
  /** Vertical offset, fraction of R (negative = up). */
  oy: number;
  /** Horizontal offset, fraction of R. */
  ox: number;
  /** Body rotation, radians. */
  tilt: number;
  /** Head turn added to the look yaw. */
  yaw: number;
  /** Scale multipliers (1 = none). */
  sx: number;
  sy: number;
  /** How far each hand is raised, 0…1. */
  handL: number;
  handR: number;
}

/**
 * One hop per beat, one sway per two beats. At the top of a hop Mochi leans to
 * one side; on landing it is upright and squashed.
 */
export function dancePose(t: number): DancePose {
  const s = Math.sin((Math.PI * t) / BEAT); // period 2 beats
  const hop = Math.abs(s); // 0 on each beat (landing), 1 between beats
  // Squash peaks on landing. Built from s² (smooth through the beat) rather than
  // |s|, whose corner made the squash snap by 2 % in a single frame.
  const land = Math.pow(1 - s * s, 4);
  return {
    oy: -hop * 0.09,
    ox: s * 0.05,
    tilt: s * 0.14,
    yaw: s * 0.22,
    sx: 1 + 0.06 * land,
    sy: 1 - 0.07 * land,
    handL: Math.max(0, s),
    handR: Math.max(0, -s),
  };
}

/** True when a two-beat boundary lies in (prevT, t] — time to float a music note. */
export function noteDue(prevT: number, t: number): boolean {
  if (!(t > prevT)) return false;
  const bar = BEAT * 2;
  return Math.floor(t / bar) > Math.floor(prevT / bar);
}

// ── Triggers ──────────────────────────────────────────────────────────────────

type Data = Record<string, unknown> | null | undefined;
type Trigger = { name: ActName; variant: string | null };

interface ShelfItem { path?: unknown; modified?: unknown }
interface SpaceItem { done?: unknown }

const listOf = <T>(data: Data, key: string): T[] =>
  data && Array.isArray(data[key]) ? (data[key] as T[]) : [];

/**
 * A file that was not on the shelf before, or one saved again since. Items
 * leaving (the 3-day window, an unpin) never count.
 */
export function newShelfItem(prev: Data, next: Data): boolean {
  for (const key of ["pinned", "screenshots", "downloads"]) {
    const before = new Map<string, number>();
    for (const it of listOf<ShelfItem>(prev, key)) {
      if (typeof it.path === "string") before.set(it.path, typeof it.modified === "number" ? it.modified : 0);
    }
    for (const it of listOf<ShelfItem>(next, key)) {
      if (typeof it.path !== "string") continue;
      const was = before.get(it.path);
      if (was === undefined) return true;
      if (typeof it.modified === "number" && it.modified > was) return true;
    }
  }
  return false;
}

const doneCount = (data: Data) => listOf<SpaceItem>(data, "items").filter((i) => i.done === true).length;

/**
 * The one-shot act an update starts, if any. `prev` is the pill's data before
 * this update, null on the first load (the backlog is not news).
 */
export function detectAct(
  id: string, prev: Data, next: Data, event: { success: boolean } | null | undefined,
): Trigger | null {
  switch (id) {
    case MESSAGES_PILL_ID:
      // Rust only sends an event for toasts it has not seen (never the backlog).
      return event?.success ? { name: "mail", variant: null } : null;
    case SHELF_PILL_ID:
      return prev && next && newShelfItem(prev, next) ? { name: "catch", variant: null } : null;
    case SPACE_PILL_ID: {
      if (!prev || !next || doneCount(next) <= doneCount(prev)) return null;
      const items = listOf<SpaceItem>(next, "items");
      return { name: "check", variant: items.every((i) => i.done === true) ? "all" : null };
    }
    default:
      return null;
  }
}

/** Acts that last while their trigger holds, read from the pill each frame. */
export function continuousAct(task: Pick<AgentTask, "id" | "state">, data: Data): Trigger | null {
  if (isDancing(task)) return { name: "dance", variant: null };
  if (task.id === AUDIO_PILL_ID && listOf<string>(data, "micUsers").length > 0) {
    const input = data?.input as { muted?: unknown } | null | undefined;
    return { name: "mic", variant: input?.muted === true ? "muted" : null };
  }
  return null;
}

/** What Mochi plays for this pill right now: a live one-shot first, then a continuous act. */
export function actFor(
  task: (Pick<AgentTask, "id" | "state"> & { act?: Act | null }) | null | undefined,
  data: Data,
  nowMs: number,
): Act | null {
  if (!task) return null;
  const a = task.act;
  if (a && nowMs >= a.at && nowMs < a.at + actDurationMs(a.name, a.variant)) return a;
  const c = continuousAct(task, data);
  return c ? { ...c, at: 0 } : null;
}

/** Same act (a variant change, such as muting the mic, is not a new act). */
export const actKey = (a: Act | null) => (a ? `${a.name}@${a.at}` : "");

// ── Timing helpers ────────────────────────────────────────────────────────────

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (v: number) => { const c = clamp01(v); return c * c * (3 - 2 * c); };
/** 0 → 1 between a and b, eased. */
const ramp = (age: number, a: number, b: number) => smooth((age - a) / (b - a));
/** Gaussian bump centred on c. */
const bump = (age: number, c: number, w: number) => Math.exp(-(((age - c) / w) ** 2));
/** Back-out pop 0 → 1 (overshoots a little), for props appearing. */
export function pop(v: number): number {
  const c = clamp01(v);
  const s = 1.7;
  const p = c - 1;
  return 1 + p * p * ((s + 1) * p + s);
}

/** 1 during the act, easing to 0 over its last 0.45 s, so a one-shot never snaps off. */
export function endFade(name: ActName, variant: string | null, age: number): number {
  const d = actDurationMs(name, variant) / 1000;
  if (!Number.isFinite(d)) return 1;
  return 1 - ramp(age, d - 0.45, d);
}

/** Moments inside the one-shots. */
export const MAIL_OPEN = 0.95;
export const CATCH_LAND = 0.85;
export const CHECK_DONE = 0.85;

// ── Poses ─────────────────────────────────────────────────────────────────────

/**
 * Pose of an act `age` seconds after it started, `t` the engine's free clock
 * (continuous acts follow `t` so they keep their rhythm).
 */
export function actPose(name: ActName, variant: string | null, age: number, t: number): Pose {
  switch (name) {
    case "dance":
      return { ...dancePose(t), pitch: 0 };
    case "mic": {
      if (variant === "muted") {
        // Muted on a call: still, slow breath, a small sulky lean.
        const b = Math.sin(2 * Math.PI * 0.5 * t);
        return { ...NEUTRAL, tilt: 0.05, sy: 1 + 0.015 * b, sx: 1 - 0.01 * b };
      }
      // Talking: a quick nod on syllables, a slow head turn.
      const s = Math.sin(2 * Math.PI * 1.6 * t);
      return {
        ...NEUTRAL,
        oy: -Math.max(0, s) * 0.03,
        pitch: -Math.max(0, s) * 0.08, // nod down (positive pitch looks up)
        yaw: Math.sin(2 * Math.PI * 0.3 * t) * 0.1,
        tilt: Math.sin(2 * Math.PI * 0.4 * t) * 0.05,
        sy: 1 + 0.02 * s,
        sx: 1 - 0.012 * s,
      };
    }
    case "mail": {
      const e = endFade(name, variant, age);
      const hop = age < 0.7 ? Math.sin((Math.PI * age) / 0.7) : 0;
      const land = bump(age, 0.72, 0.1);
      const sway = age > 0.9 ? Math.sin(2 * Math.PI * 0.9 * (age - 0.9)) : 0;
      const hands = ramp(age, 0.02, 0.25) * (1 - ramp(age, 0.6, 0.95));
      return {
        ...NEUTRAL,
        oy: -0.28 * hop * e,
        tilt: 0.1 * sway * e,
        sx: 1 + 0.1 * land * e,
        sy: 1 - 0.12 * land * e,
        handL: hands * e,
        handR: hands * e,
      };
    }
    case "catch": {
      const e = endFade(name, variant, age);
      const look = ramp(age, 0, 0.35) * (1 - ramp(age, CATCH_LAND, 1.25));
      const since = age - CATCH_LAND;
      const wobble = since > 0 ? Math.exp(-since * 3) * Math.sin(2 * Math.PI * 3 * since) : 0;
      const land = bump(age, CATCH_LAND + 0.05, 0.09);
      return {
        ...NEUTRAL,
        pitch: 0.45 * look * e, // looks up at the falling file
        oy: 0.04 * land * e,
        tilt: 0.12 * wobble * e,
        sx: 1 + 0.1 * land * e,
        sy: 1 - 0.12 * land * e,
      };
    }
    case "check": {
      const e = endFade(name, variant, age);
      const hops = variant === "all" ? 3 : 1;
      let hop = 0;
      for (let i = 0; i < hops; i++) {
        const a0 = CHECK_DONE + i * 0.5;
        if (age > a0 && age < a0 + 0.4) hop = Math.sin((Math.PI * (age - a0)) / 0.4);
      }
      const proud = ramp(age, CHECK_DONE, CHECK_DONE + 0.25);
      return {
        ...NEUTRAL,
        oy: -0.15 * hop * e,
        tilt: -0.12 * proud * e,
        handR: 0.55 * ramp(age, 0, 0.3) * e,
      };
    }
  }
}

/** Eye shape for the act, or null to keep the state's own eyes. */
export function actEye(name: ActName, variant: string | null, age: number): EyeShape | null {
  switch (name) {
    case "dance": return "happy";
    case "mic": return null;
    case "mail": return age < 0.8 ? "dot" : "happy";
    case "catch": return age < CATCH_LAND ? null : "happy";
    case "check": return age < CHECK_DONE ? null : variant === "all" ? "star" : "happy";
  }
}

/** Prop timings the engine draws with, all 0…1. */
export interface Props {
  /** Prop scale-in (pop). */
  show: number;
  /** Envelope flap opening. */
  flap: number;
  /** File sheet falling into the box (1 = landed). */
  fall: number;
  /** Check mark stroke drawn. */
  stroke: number;
}

export function actProps(name: ActName, variant: string | null, age: number): Props {
  const e = endFade(name, variant, age);
  switch (name) {
    case "mail":
      return { show: pop(age / 0.3) * e, flap: ramp(age, 0.6, MAIL_OPEN), fall: 0, stroke: 0 };
    case "catch":
      return { show: pop(age / 0.25) * e, flap: 0, fall: clamp01(age / CATCH_LAND), stroke: 0 };
    case "check":
      return { show: pop(age / 0.3) * e, flap: 0, fall: 0, stroke: ramp(age, 0.45, CHECK_DONE) };
    default:
      return { show: 1, flap: 0, fall: 0, stroke: 0 };
  }
}

export type BurstType = "heart" | "spark" | "star";

/** Particle bursts whose moment falls in (prevAge, age]. */
export function actBursts(
  name: ActName, variant: string | null, prevAge: number, age: number,
): { type: BurstType; count: number }[] {
  const at: [number, BurstType, number][] =
    name === "mail" ? [[MAIL_OPEN, "heart", 4]] :
    name === "catch" ? [[CATCH_LAND, "spark", 5]] :
    name === "check" && variant === "all" ? [[CHECK_DONE, "star", 5], [CHECK_DONE + 0.5, "spark", 6], [CHECK_DONE + 1, "star", 5]] :
    name === "check" ? [[CHECK_DONE, "star", 3]] : [];
  return at.filter(([m]) => m > prevAge && m <= age).map(([, type, count]) => ({ type, count }));
}
