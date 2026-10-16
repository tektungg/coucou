// A press on the island's Mochi: a click slaps him, a drag past
// DRAG_THRESHOLD carries him out to the desktop. Ported from upstream
// (Louis-CFM/coucou 7a8d5e6), where it lived in island.ts. Here the slap waits
// for the button to come up, so dragging him out never slaps him first.

import { State } from "../core/state";
import type { BotEngine } from "../mochi/engine";
import { DRAG_THRESHOLD } from "../mochi/desktopLogic";
import type { DesktopLink } from "./desktop";

const LEFT_BUTTON = 0;
/** MouseEvent.buttons bit of the left button. */
const LEFT_HELD = 1;

export interface BotDragHost {
  readonly desktop: DesktopLink;
  /** The drop sequence owns the island body (it draws a Mochi of its own). */
  readonly uploadActive: boolean;
  isBotHit(x: number, y: number): boolean;
  readonly engine: BotEngine;
  cancelBotHover(): void;
}

interface Press {
  x: number;
  y: number;
  /** Pressed on the open island: letting go without a drag slaps him. */
  slaps: boolean;
}

export class BotDrag {
  private readonly host: BotDragHost;
  private press: Press | null = null;

  constructor(host: BotDragHost) {
    this.host = host;
    window.addEventListener("mousemove", (e) => this.moved(e));
    window.addEventListener("mouseup", (e) => this.released(e));
  }

  /** A mousedown on the island; true when it landed on Mochi. */
  pressed(e: MouseEvent): boolean {
    if (e.button !== LEFT_BUTTON || !this.host.isBotHit(e.clientX, e.clientY)) return false;
    this.press = { x: e.clientX, y: e.clientY, slaps: State.mode === "expanded" };
    return true;
  }

  private moved(e: MouseEvent) {
    const desktop = this.host.desktop;
    if (desktop.carrying) {
      desktop.carry(e.clientX, e.clientY);
      return;
    }
    const press = this.press;
    if (!press) return;
    if (!(e.buttons & LEFT_HELD)) {
      this.press = null;
      return;
    }
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= DRAG_THRESHOLD) return;
    this.press = null;
    if (!this.canDragOut()) return;
    this.host.cancelBotHover();
    desktop.pickUp(e.clientX, e.clientY);
  }

  private released(e: MouseEvent) {
    const press = this.press;
    this.press = null;
    const desktop = this.host.desktop;
    if (desktop.carrying) {
      desktop.carryEnd(e.clientX, e.clientY);
      return;
    }
    if (press?.slaps) this.host.engine.slap();
  }

  /** The greeting and the drop sequence draw a Mochi of their own: not that one. */
  private canDragOut(): boolean {
    if (State.mode === "hidden" || !this.host.desktop.canPickUp()) return false;
    return !(State.mode === "expanded" && (State.view === "greeting" || this.host.uploadActive));
  }
}
