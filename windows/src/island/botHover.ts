// Resting the pointer on Mochi: he blinks, grows a little, and after a moment
// sends hearts (IslandWindowController.botHoverIn on macOS). Split out of
// island.ts.

import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { BotEngine } from "../mochi/engine";

/** Moving this far across Mochi while resting on him starts the hearts again. */
const RESTART_PX = 40;
/** How long the pointer rests before the hearts. */
const LOVE_AFTER_MS = 1900;
/** Hearts at most this often, seconds. */
const LOVE_COOLDOWN_S = 6;
/** Mochi's eye scale while the pointer rests on him. */
const HOVER_EYE_SCALE = 1.08;

export class BotHover {
  private readonly engine: BotEngine;
  private hovering = false;
  private timer: number | null = null;
  private lastLoveS = 0;
  private start = { x: 0, y: 0 };

  constructor(engine: BotEngine) {
    this.engine = engine;
  }

  /** Called with every cursor move; `overBot` is whether the pointer is on Mochi. */
  track(x: number, y: number, overBot: boolean) {
    if (overBot && !this.hovering) this.hoverIn(x, y);
    if (!overBot && this.hovering) this.cancel();
    this.hovering = overBot;
    if (!this.hovering) return;
    if (Math.hypot(x - this.start.x, y - this.start.y) > RESTART_PX) {
      this.start = { x, y };
      this.scheduleLove();
    }
  }

  /** A click on Mochi (a slap) ends the hover. */
  cancel() {
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
    this.engine.tgEs = 1;
  }

  private coolingDown(): boolean {
    return performance.now() / 1000 - this.lastLoveS < LOVE_COOLDOWN_S;
  }

  private hoverIn(x: number, y: number) {
    if (this.coolingDown()) return;
    this.start = { x, y };
    this.engine.blink();
    this.engine.tgEs = HOVER_EYE_SCALE;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (!this.hovering || State.stateOverride != null || this.coolingDown()) return;
      this.lastLoveS = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, LOVE_AFTER_MS);
  }
}
