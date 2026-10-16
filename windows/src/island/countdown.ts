// The auto-close bar under the open island. Split out of island.ts.

import { clamp } from "../core/anim";
import { State } from "../core/state";
import { h } from "../views/dom";
import type { IslandStateMachine } from "./fsm";

/** Width of the bar when the countdown starts. */
const BAR_W = 160;
/** Longest countdown shown, seconds, and its share of the auto-close delay. */
const MAX_WINDOW_S = 10;
const WINDOW_SHARE = 0.6;

export class Countdown {
  readonly el = h("div", { id: "countdown" });

  /**
   * Follows the state machine's own deadline, so the bar keeps up with an
   * auto-close delay edited while it runs, and with a message glance's 3 s.
   */
  update(fsm: IslandStateMachine, nowMs: number) {
    const dueAt = fsm.homeCollapseDueAt;
    if (State.mode !== "expanded" || State.isPinned || dueAt == null) {
      this.el.style.width = "0px";
      return;
    }
    const windowS = fsm.homeCollapseWindowS ?? Math.min(MAX_WINDOW_S, fsm.homeToPetitDelay * WINDOW_SHARE);
    const remaining = (dueAt - nowMs) / 1000;
    this.el.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * BAR_W)}px` : "0px";
  }
}
