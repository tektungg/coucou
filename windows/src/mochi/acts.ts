// Mochi's acts: a themed animation per personal pill, played only on a real
// event (Music playing, the mic in use, a new message, a new file on the shelf,
// a Space item done). Everything here is a pure function of the pill data and
// of time, so it is tested in tests/acts.test.ts; BotEngine fades the pose in
// and out, adds it on top of its own animation and draws the props.

import type { AgentTask } from "../core/state";
import type { EyeShape } from "./engine";

export type ActName = "dance" | "mic" | "mail" | "catch" | "check" | "claude" | "claudeEnd" | "music" | "musicCue";

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
export const CLAUDE_CATCHALL_ID = "integration_claude";

/** The one-shots a Claude Code session plays as it ends a turn (claudeProps.ts). */
export const CLAUDE_FINISHED_MS = 2600;
export const CLAUDE_ERROR_MS = 2400;
export const MESSAGES_PILL_ID = "integration_messages";
export const SHELF_PILL_ID = "integration_shelf";
export const SPACE_PILL_ID = "integration_space";

/** One-shot lengths. Continuous acts (dance, mic) last as long as their trigger. */
export function actDurationMs(name: ActName, variant: string | null): number {
  switch (name) {
    case "mail": return 3200;
    case "catch": return 2600;
    case "check": return variant === "all" ? 3600 : 2800;
    case "claudeEnd": return variant === "error" ? CLAUDE_ERROR_MS : CLAUDE_FINISHED_MS;
    case "musicCue": return MUSIC_CUE_MS[variant ?? ""] ?? MUSIC_CUE_DEFAULT_MS;
    default: return Number.POSITIVE_INFINITY;
  }
}

/** One-shots play once from `at`; continuous acts follow the engine's free clock. */
export const isOneShot = (name: ActName) => Number.isFinite(actDurationMs(name, null));

/** Acts whose hands come out from behind the body. */
export const ACT_HANDS: ReadonlySet<ActName> = new Set<ActName>(["dance", "mail", "check"]);

/**
 * Whether the act brings the hands out from behind the body. The Music acts
 * that hold something draw their own hands with the prop (musicProps.ts), so
 * only the plain bop uses these.
 */
export function actShowsHands(a: Act | null): boolean {
  if (!a) return false;
  return ACT_HANDS.has(a.name) || (a.name === "music" && a.variant === "1A");
}

/** Acts that float music notes on the beat: the groove and the singing ones. */
export function actFloatsNotes(a: Act | null): boolean {
  if (!a) return false;
  return a.name === "dance" || (a.name === "music" && /^[12]/.test(a.variant ?? ""));
}

// ── Music groove ─────────────────────────────────────────────────────────────
// While the Music pill plays, Mochi wears headphones and dances.

/** Fixed tempo. The real track BPM is not available (Spotify closed audio features). */
export const DANCE_BPM = 112;
export const BEAT = 60 / DANCE_BPM;

export const MEDIA_PILL_ID = "integration_media";

// ── Music acts (options page) ─────────────────────────────────────────────────
// `music` is continuous: 1x playing, 2x singing along, 3x paused. `musicCue` is
// a one-shot: 4x the track changed, 5x playback resumed. Each digit is a state,
// each letter one design; dev/music-acts-options.html shows them all so the
// ones that ship can be picked. Props: musicProps.ts.

/** One-shot lengths per musicCue variant. */
export const MUSIC_CUE_MS: Record<string, number> = {
  "4A": 1800, "4B": 1800, "4C": 1500, "5A": 1600, "5B": 1500, "5C": 1600,
};
export const MUSIC_CUE_DEFAULT_MS = 1800;

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

// ── Claude Code sessions ──────────────────────────────────────────────────────
// Mochi acts out what a focused Claude Code session is doing: a prop per state,
// and for tool use, a prop per kind of tool (claudeProps.ts).

export type ToolKind = "edit" | "bash" | "read";

const TOOL_KINDS: Record<string, ToolKind> = {
  Bash: "bash", PowerShell: "bash",
  Read: "read", Grep: "read", Glob: "read", LS: "read", WebSearch: "read", WebFetch: "read",
};

/** Which prop a tool gets; editing tools and anything unknown type on the keyboard. */
export const toolKind = (tool: string): ToolKind => TOOL_KINDS[tool] ?? "edit";

type SessionLike = Pick<AgentTask, "id" | "state" | "source" | "steps"> & { toolKind?: ToolKind | null };

/** A Claude Code session; the catch-all pill only while a session without its own pill runs. */
export function isClaudeSessionTask(task: SessionLike): boolean {
  if (task.source !== "claudeCode") return false;
  return task.id !== CLAUDE_CATCHALL_ID || task.state !== "idle" || task.steps.length > 0;
}

/** States whose prop lasts as long as the state (finished has only its one-shot). */
const CLAUDE_STATES = new Set(["idle", "thinking", "working", "question", "approval", "ratelimit", "error"]);

function claudeAct(task: SessionLike): Trigger | null {
  if (!isClaudeSessionTask(task) || !CLAUDE_STATES.has(task.state)) return null;
  const variant = task.state === "working" ? `working:${task.toolKind ?? "edit"}` : task.state;
  return { name: "claude", variant };
}

/** The one-shot a session plays as it moves into finished or error, else null. */
export function sessionEndAct(prev: string, next: string): Trigger | null {
  if (prev === next || (next !== "finished" && next !== "error")) return null;
  return { name: "claudeEnd", variant: next };
}

/** Acts that last while their trigger holds, read from the pill each frame. */
export function continuousAct(task: SessionLike, data: Data): Trigger | null {
  const claude = claudeAct(task);
  if (claude) return claude;
  if (isDancing(task)) return { name: "dance", variant: null };
  if (task.id === AUDIO_PILL_ID && listOf<string>(data, "micUsers").length > 0) {
    const input = data?.input as { muted?: unknown } | null | undefined;
    return { name: "mic", variant: input?.muted === true ? "muted" : null };
  }
  return null;
}

/** What Mochi plays for this pill right now: a live one-shot first, then a continuous act. */
export function actFor(
  task: (SessionLike & { act?: Act | null }) | null | undefined,
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

function micPose(variant: string | null, t: number): Pose {
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

function mailPose(variant: string | null, age: number): Pose {
  const e = endFade("mail", variant, age);
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

function catchPose(variant: string | null, age: number): Pose {
  const e = endFade("catch", variant, age);
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

function checkPose(variant: string | null, age: number): Pose {
  const e = endFade("check", variant, age);
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

type PoseOf = (variant: string | null, age: number, t: number) => Pose;

/** 1 on each beat, decaying until the next: a nod or a stomp. */
const onBeat = (t: number, k = 6) => Math.exp(-((((t / BEAT) % 1) + 1) % 1) * k);

/** Music, continuous: 1x playing, 2x singing, 3x paused. */
function musicPose(variant: string | null, t: number): Pose {
  const bar = Math.sin((2 * Math.PI * t) / (BEAT * 4)); // one sway per 4 beats
  const nod = onBeat(t);
  switch (variant) {
    case "1A":
      return { ...dancePose(t), pitch: 0 };
    case "1B": // DJ: a hard nod on every beat over the decks
      return {
        ...NEUTRAL, pitch: -0.14 * nod, oy: 0.02 * nod, sy: 1 - 0.035 * nod, sx: 1 + 0.025 * nod,
        yaw: 0.12 * bar, tilt: 0.04 * bar,
      };
    case "1C": { // Boombox: a side-step, squashed on each landing
      const s = Math.sin((Math.PI * t) / BEAT);
      const land = Math.pow(1 - s * s, 4);
      return { ...NEUTRAL, ox: 0.09 * s, tilt: -0.08 * s, yaw: 0.15 * s, sx: 1 + 0.045 * land, sy: 1 - 0.05 * land };
    }
    case "2A": // Karaoke: a slow sway, leaning into the mic on the beat
      return { ...NEUTRAL, tilt: 0.07 * bar, ox: 0.03 * bar, pitch: -0.06 * nod, oy: -0.015 * nod };
    case "2B": { // Crooner at a stand mic: leaning in, swaying slowly
      const slow = Math.sin((2 * Math.PI * t) / (BEAT * 8));
      return { ...NEUTRAL, pitch: -0.1 - 0.04 * slow, yaw: 0.08 * slow, tilt: 0.05 * slow, sy: 1 + 0.02 * Math.sin((Math.PI * t) / BEAT) };
    }
    case "2C": // Hairbrush diva: head thrown back, rocking
      return { ...NEUTRAL, tilt: -0.14 + 0.08 * bar, pitch: 0.12, oy: -0.02 * nod, sy: 1 + 0.02 * nod };
    case "3A":
    case "3B":
    case "3C":
      return pausedPose(variant, t);
    default:
      return NEUTRAL;
  }
}

/** Paused: breathing, waiting. */
function pausedPose(variant: string, t: number): Pose {
  if (variant === "3C") { // dozing
    const b = Math.sin(2 * Math.PI * 0.25 * t);
    return { ...NEUTRAL, sy: 1 + 0.04 * b, sx: 1 - 0.025 * b, tilt: 0.08, pitch: -0.08, oy: 0.03 };
  }
  const b = Math.sin(2 * Math.PI * 0.35 * t);
  if (variant === "3B") { // looking down at the tape, tapping a foot
    const tap = Math.exp(-((t / 0.9) % 1) * 8);
    return { ...NEUTRAL, pitch: -0.12, oy: 0.015 * tap, sy: 1 - 0.02 * tap + 0.012 * b, tilt: 0.03 * b };
  }
  return { ...NEUTRAL, sy: 1 + 0.02 * b, sx: 1 - 0.012 * b, tilt: 0.04, pitch: -0.04, oy: 0.02 };
}

/** One-shot timing helpers for the cues. */
const hopAt = (age: number, a: number, b: number, h: number) =>
  (age > a && age < b ? -h * Math.sin((Math.PI * (age - a)) / (b - a)) : 0);

/** Music cue, one-shot: 4x the track changed, 5x playback resumed. */
function musicCueShape(variant: string | null, age: number): Pose {
  const squash = (c: number) => bump(age, c, 0.08);
  switch (variant) {
    case "4A": { // looks up at the new record, catches it, hops
      const look = ramp(age, 0.05, 0.3) * (1 - ramp(age, 0.8, 1.0));
      return { ...NEUTRAL, pitch: 0.35 * look, yaw: 0.2 * look, oy: hopAt(age, 1.0, 1.35, 0.14) + 0.03 * squash(0.9), sx: 1 + 0.08 * squash(0.9), sy: 1 - 0.1 * squash(0.9) };
    }
    case "4B": // looks down at the tape, a bounce once it is flipped
      return { ...NEUTRAL, pitch: -0.15 * (1 - ramp(age, 1.05, 1.3)), oy: hopAt(age, 1.1, 1.4, 0.1), sx: 1 + 0.06 * squash(1.1), sy: 1 - 0.07 * squash(1.1) };
    case "4C": { // follows the swipe with the head, then settles
      const sw = ramp(age, 0.1, 0.55);
      return { ...NEUTRAL, yaw: -0.3 + 0.7 * sw - 0.4 * ramp(age, 0.7, 1.1), tilt: 0.08 * Math.sin(Math.PI * sw), oy: hopAt(age, 0.6, 0.9, 0.08) };
    }
    case "5A": { // crouches as the needle comes down, jumps when it lands
      const crouch = ramp(age, 0.05, 0.5) * (1 - ramp(age, 0.5, 0.6));
      const up = -hopAt(age, 0.55, 0.95, 1);
      return { ...NEUTRAL, sy: 1 - 0.08 * crouch + 0.06 * up, sx: 1 + 0.06 * crouch, oy: 0.04 * crouch + hopAt(age, 0.55, 0.95, 0.2) + 0.03 * squash(0.97), pitch: -0.1 * crouch };
    }
    case "5B": { // leans in, presses play, hops
      const lean = ramp(age, 0.05, 0.4) * (1 - ramp(age, 0.45, 0.6));
      return { ...NEUTRAL, pitch: -0.15 * lean, oy: 0.03 * lean + hopAt(age, 0.5, 0.85, 0.16), sy: 1 - 0.08 * squash(0.45), sx: 1 + 0.06 * squash(0.45) };
    }
    case "5C": // looks up while the headphones go on, a happy hop on the click
      return { ...NEUTRAL, pitch: 0.1 * (1 - ramp(age, 0.55, 0.7)), oy: hopAt(age, 0.65, 1.0, 0.14), sx: 1 + 0.07 * squash(0.65), sy: 1 - 0.08 * squash(0.65) };
    default:
      return NEUTRAL;
  }
}

/** The cue's shape, eased out over its last moments like every one-shot. */
function musicCuePose(variant: string | null, age: number): Pose {
  const e = endFade("musicCue", variant, age);
  const p = musicCueShape(variant, age);
  return {
    ...p, oy: p.oy * e, ox: p.ox * e, tilt: p.tilt * e, yaw: p.yaw * e, pitch: p.pitch * e,
    sx: 1 + (p.sx - 1) * e, sy: 1 + (p.sy - 1) * e,
  };
}

const POSES: Record<ActName, PoseOf> = {
  dance: (_v, _age, t) => ({ ...dancePose(t), pitch: 0 }),
  mic: (variant, _age, t) => micPose(variant, t),
  mail: mailPose,
  catch: catchPose,
  check: checkPose,
  // The state's own animation carries it; the prop does the rest.
  claude: () => NEUTRAL,
  claudeEnd: (variant, age) => claudeEndPose(variant, age),
  music: (variant, _age, t) => musicPose(variant, t),
  musicCue: (variant, age) => musicCuePose(variant, age),
};

/**
 * Pose of an act `age` seconds after it started, `t` the engine's free clock
 * (continuous acts follow `t` so they keep their rhythm).
 */
export function actPose(name: ActName, variant: string | null, age: number, t: number): Pose {
  return POSES[name](variant, age, t);
}

/** Finished: two happy hops while the confetti flies. Error: a flinch that settles. */
function claudeEndPose(variant: string | null, age: number): Pose {
  const e = endFade("claudeEnd", variant, age);
  if (variant === "error") {
    return { ...NEUTRAL, ox: Math.sin(age * 30) * 0.035 * Math.exp(-age * 2.5) * e };
  }
  const hop = Math.max(0, Math.sin((age / (CLAUDE_FINISHED_MS / 1000)) * Math.PI * 4));
  return { ...NEUTRAL, oy: -0.12 * hop * e, sy: 1 + 0.04 * hop * e, sx: 1 - 0.03 * hop * e };
}

type EyeOf = (variant: string | null, age: number) => EyeShape | null;

const EYES: Record<ActName, EyeOf> = {
  dance: () => "happy",
  mic: () => null,
  mail: (_v, age) => (age < 0.8 ? "dot" : "happy"),
  catch: (_v, age) => (age < CATCH_LAND ? null : "happy"),
  check: (variant, age) => {
    if (age < CHECK_DONE) return null;
    return variant === "all" ? "star" : "happy";
  },
  claude: () => null,
  claudeEnd: (variant) => (variant === "finished" ? "happy" : null),
  music: (variant) => MUSIC_EYES[variant ?? ""] ?? null,
  musicCue: (variant, age) => {
    const [before, at] = MUSIC_CUE_EYES[variant ?? ""] ?? [null, Infinity];
    return age < at ? before : "happy";
  },
};

const MUSIC_EYES: Record<string, EyeShape | null> = {
  "1A": "happy", "1B": null, "1C": "happy", "2A": "happy", "2B": "closed", "2C": "closed",
  "3A": null, "3B": null, "3C": "closed",
};
/** Eyes before the cue's moment, then happy from that second on. */
const MUSIC_CUE_EYES: Record<string, [EyeShape | null, number]> = {
  "4A": ["wide", 0.85], "4B": [null, 1.1], "4C": ["wide", 0.55], "5A": [null, 0.55], "5B": [null, 0.45], "5C": [null, 0.65],
};

/** Eye shape for the act, or null to keep the state's own eyes. */
export function actEye(name: ActName, variant: string | null, age: number): EyeShape | null {
  return EYES[name](variant, age);
}

/**
 * Lowest head pitch the look may reach during the act, or null for no limit.
 * The envelope is held in front of the body: looking down at the cursor would
 * lower the eyes into it.
 */
export function actPitchFloor(name: ActName): number | null {
  return name === "mail" ? 0 : null;
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

export type BurstType = "heart" | "spark" | "star" | "note";

/** musicCue moments: [seconds, burst, count]. */
const MUSIC_CUE_BURSTS: Record<string, [number, BurstType, number][]> = {
  "4A": [[0.9, "spark", 5], [1.0, "note", 2]], "4B": [[1.1, "spark", 4]], "4C": [[0.5, "spark", 4]],
  "5A": [[0.55, "star", 3], [0.6, "note", 3]], "5B": [[0.45, "spark", 6], [0.5, "note", 2]], "5C": [[0.65, "star", 4], [0.7, "note", 3]],
};

/** Particle bursts whose moment falls in (prevAge, age]. */
export function actBursts(
  name: ActName, variant: string | null, prevAge: number, age: number,
): { type: BurstType; count: number }[] {
  const at: [number, BurstType, number][] =
    name === "mail" ? [[MAIL_OPEN, "heart", 4]] :
    name === "catch" ? [[CATCH_LAND, "spark", 5]] :
    name === "check" && variant === "all" ? [[CHECK_DONE, "star", 5], [CHECK_DONE + 0.5, "spark", 6], [CHECK_DONE + 1, "star", 5]] :
    name === "check" ? [[CHECK_DONE, "star", 3]] :
    name === "musicCue" ? MUSIC_CUE_BURSTS[variant ?? ""] ?? [] : [];
  return at.filter(([m]) => m > prevAge && m <= age).map(([, type, count]) => ({ type, count }));
}
