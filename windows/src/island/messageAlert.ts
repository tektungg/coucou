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
}

/**
 * "open": open the island on the Messages pill, it closes itself after the
 * auto-close delay. "focus": the overview is already open, just switch to the
 * Messages pill. "none": something more important owns the island; the pill
 * badge and the sound are enough.
 */
export type MessageAlertAction = "open" | "focus" | "none";

export function messageAlertAction(c: MessageAlertContext): MessageAlertAction {
  if (c.pinned || c.waiting || c.pointerInIsland) return "none";
  if (c.mode !== "expanded") return "open";
  return c.view === "overview" ? "focus" : "none";
}
