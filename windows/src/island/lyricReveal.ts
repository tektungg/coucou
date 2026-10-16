// The Music pill's lyrics and the compact island: while a song plays it stays
// up with them, and a song starting brings it back, never over a fullscreen
// game, video or presentation. Split out of island.ts.

import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { lyricStripActive } from "../views/personal";
import type { IslandStateMachine } from "./fsm";

export function wireLyricReveal(fsm: IslandStateMachine) {
  fsm.keepPetit = () => (lyricStripActive() ? Bridge.fullscreenActive().then((f) => f !== true) : false);

  /** Shows the compact island for a song's lyrics, never over a fullscreen app. */
  const reveal = async () => {
    if ((await Bridge.fullscreenActive()) === true) return;
    if (State.mode === "hidden" && lyricStripActive()) fsm.reveal();
  };

  let wasActive = false;
  State.subscribe(() => {
    const active = lyricStripActive();
    if (active && !wasActive && State.mode === "hidden") void reveal();
    wasActive = active;
  });
}
