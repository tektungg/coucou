// Three slaps in a row: Mochi goes dizzy and the island shows the confused
// view for a moment, then goes back to where it was. Split out of island.ts.

import type { IslandViewName } from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { BotEngine } from "../mochi/engine";

/** How long Mochi stays dizzy. */
const DIZZY_MS = 3300;

export interface DizzyHost {
  readonly engine: BotEngine;
  alert(view: IslandViewName): void;
  setView(view: IslandViewName): void;
}

export class Dizzy {
  private readonly host: DizzyHost;
  private recovery: number | null = null;
  private viewBefore: IslandViewName = "overview";

  constructor(host: DizzyHost) {
    this.host = host;
  }

  start() {
    const { engine } = this.host;
    this.viewBefore = State.view;
    State.stateOverride = "dizzy";
    engine.setState("dizzy");
    Sound.play("dizzy");
    this.host.alert("confused");
    if (this.recovery != null) window.clearTimeout(this.recovery);
    this.recovery = window.setTimeout(() => this.recover(), DIZZY_MS);
  }

  private recover() {
    const { engine } = this.host;
    this.recovery = null;
    State.stateOverride = null;
    engine.setState(State.effectiveState);
    if (State.view === "confused") {
      this.host.setView(this.viewBefore === "confused" ? State.defaultView() : this.viewBefore);
    }
    engine.triggerEmote("happy");
  }
}
