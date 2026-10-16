// Hidden island → the window drops to a tiny wake strip, so the OS delivers
// no cursor events and nothing polls at all. Split out of island.ts.

import { Bridge } from "../core/bridge";
import type { IslandMode } from "../core/layout";
import { State } from "../core/state";

/** Lets the island finish retracting before the window shrinks. */
const RETRACT_MS = 420;

export class WindowCollapse {
  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private timer: number | null = null;

  /** Follows the island's mode: shrink once hidden, grow back before it opens. */
  update(mode: IslandMode) {
    if (this.timer != null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (mode === "hidden") {
      this.timer = window.setTimeout(() => {
        this.timer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, RETRACT_MS);
    } else if (this.collapsed) {
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }
}
