// Mochi's music groove: while the Music pill is playing, Mochi wears headphones
// and dances. Everything here is a pure function of time so it can be tested;
// BotEngine scales the pose by its `groove` fade and draws it.

import type { AgentTask } from "../core/state";

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
