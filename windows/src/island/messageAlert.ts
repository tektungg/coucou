// What the island does when a new chat message arrives. No DOM, tested alone.

import type { IslandViewName } from "../core/layout";

export interface MessageAlertContext {
  mode: "hidden" | "compact" | "expanded";
  view: IslandViewName;
  /** An approval, plan or question pinned the island open. */
  pinned: boolean;
  /** Claude Code is waiting on an approval or a question. */
  waiting: boolean;
  /** The pointer is over the island: the user is busy with it. */
  pointerInIsland: boolean;
  /** A fullscreen game, video or presentation is in front. */
  fullscreen: boolean;
}

/**
 * "open": open the island on the Messages pill, it closes itself after the
 * auto-close delay. "focus": the overview is already open, just switch to the
 * Messages pill. "none": something more important owns the island, or a
 * fullscreen app owns the screen; the pill badge and the sound are enough.
 */
export type MessageAlertAction = "open" | "focus" | "none";

/** How long the island stays open on a new message, seconds: a glance, then back. */
export const MESSAGE_GLANCE_S = 3;

export function messageAlertAction(c: MessageAlertContext): MessageAlertAction {
  if (c.fullscreen || c.pinned || c.waiting || c.pointerInIsland) return "none";
  if (c.mode !== "expanded") return "open";
  return c.view === "overview" ? "focus" : "none";
}

/** The pill a message took the island from, so it can be given back. */
export interface GlanceReturn {
  /** Focused before the message: where to go back to. */
  to: string;
  /** The Messages pill the message switched to. */
  from: string;
}

/**
 * Where a message's glance remembers to go back to. A second message during
 * the glance keeps the first pill (not the Messages pill it is already on);
 * nothing to remember when Messages already had the focus.
 */
export function rememberGlance(
  current: GlanceReturn | null,
  focusBefore: string | null,
  messagesPill: string,
): GlanceReturn | null {
  if (current && current.from === messagesPill) return current;
  if (focusBefore == null || focusBefore === messagesPill) return null;
  return { to: focusBefore, from: messagesPill };
}

/**
 * The pill to focus when the island closes after a message's glance, or null
 * to leave the focus alone: the user moved to another pill themselves, or
 * the pill they were on is gone.
 */
export function focusAfterGlance(
  glance: GlanceReturn | null,
  focusNow: string | null,
  visible: readonly string[],
): string | null {
  if (!glance || focusNow !== glance.from) return null;
  return visible.includes(glance.to) ? glance.to : null;
}
