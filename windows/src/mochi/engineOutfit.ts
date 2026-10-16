// What Mochi wears, for his engine: the outfit on, its enter/leave, the spring
// that lags the soft parts (pompoms, hat tips, the scarf's end), the hat that
// lifts off while an act puts something on his head, and the two layers drawn
// behind and in front of the body. Ported from upstream (Louis-CFM/coucou
// 23c09b9, where it lived in engine.ts); the hat making way for head props is
// this build's own (acts.ts actCoversHead).

import { Ease } from "../core/anim";
import { actCoversHead } from "./acts";
import type { BotEngine } from "./engine";
import { PUMPKIN_BODY, drawOutfitBehind, drawOutfitFront, makeHead, type Head, type OutfitState } from "./outfits";
import type { Outfit } from "./wardrobe";

/** What sits on the head: these lift off for a head prop. Face wear stays on. */
const ON_HEAD: ReadonlySet<Outfit> = new Set(["beanie", "santaHat", "partyHat", "crown", "witchHat", "bunnyEars"]);
/** Soft-part spring: stiffness and damping (BotEngine.swift). */
const STIFFNESS = 60;
const DAMPING = 9;
/** How fast a hat lifts off for a head prop and comes back (per second, exponential). */
const HAT_AWAY_RATE = 0.0004;
/** An act this strong counts as worn: the hat makes way. */
const ACT_WORN = 0.5;
/** Below this the outfit counts as not on (no rigid roll, nothing drawn). */
const PRESENT = 0.05;
const LEAVE_MS = 180;
const ENTER_MS = 350;

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

export class OutfitRig {
  /** What is drawn; it changes only once the previous outfit has left. */
  outfit: Outfit = "none";
  /** Spring lag of the soft parts, −1…1. */
  physDx = 0;
  physDy = 0;
  /** 0 = the hat is on, 1 = lifted off for a head prop. */
  hatAway = 0;
  private target: Outfit = "none";
  private physVx = 0;
  private physVy = 0;
  private prevYaw = 0;
  private prevOy = 0;
  private prevRoll = 0;

  /** A knock to the soft parts (a squash, a slap, the greeting's wave). */
  kick(vx: number, vy: number) {
    this.physVx += vx;
    this.physVy += vy;
  }

  /**
   * Dresses Mochi. Animated: the old outfit leaves (180 ms), the new one drops
   * in (350 ms) and he does a little squash (BotEngine.setOutfit on macOS).
   */
  set(e: BotEngine, next: Outfit, animated: boolean) {
    if (next === this.target) return;
    this.target = next;
    e.stopTween("outfitPresence");
    const enter = () => {
      this.outfit = next;
      e.anim("outfitPresence", [[1, ENTER_MS, Ease.inOut]], () => e.squash());
    };
    if (!animated) {
      this.outfit = next;
      e.outfitPresence = next !== "none" ? 1 : 0;
    } else if (next === "none") {
      e.anim("outfitPresence", [[0, LEAVE_MS, Ease.inOut]], () => { this.outfit = "none"; });
    } else if (this.outfit === "none") {
      e.outfitPresence = 0;
      enter();
    } else {
      e.anim("outfitPresence", [[0, LEAVE_MS, Ease.inOut]], enter);
    }
  }

  /** Wearing something visible: the body then turns as one piece when it rolls. */
  rigidRoll(e: BotEngine): boolean {
    return !e.isMini && this.outfit !== "none" && e.outfitPresence > PRESENT;
  }

  /** Still settling: the soft parts swinging, a hat lifting off or coming back. */
  busy(e: BotEngine): boolean {
    if (this.outfit === "none") return false;
    const hatMoving = Math.abs(this.hatAwayTarget(e) - this.hatAway) > 0.002;
    return hatMoving || Math.abs(this.physVx) > 0.01 || Math.abs(this.physVy) > 0.01;
  }

  /** One frame: the soft-part spring follows head turns, hops and rolls. */
  step(e: BotEngine, dt: number) {
    if (dt > 0) {
      const yawVel = (e.yaw - this.prevYaw) / dt;
      const oyVel = (e.oy - this.prevOy) / dt;
      // A finished roll snaps from 2π·turns back to 0: that jump is not motion.
      const dRoll = e.roll - this.prevRoll;
      const rollVel = Math.abs(dRoll) > Math.PI ? 0 : dRoll / dt;
      const centrifugal = this.rigidRoll(e) ? rollVel * 0.18 : 0;
      const tDx = clamp1(-yawVel * 0.35 - e.tilt * 2 + centrifugal);
      const tDy = clamp1(oyVel * 0.5);
      this.physVx += (STIFFNESS * (tDx - this.physDx) - DAMPING * this.physVx) * dt;
      this.physVy += (STIFFNESS * (tDy - this.physDy) - DAMPING * this.physVy) * dt;
      this.physDx += this.physVx * dt;
      this.physDy += this.physVy * dt;
      this.hatAway += (this.hatAwayTarget(e) - this.hatAway) * (1 - Math.pow(HAT_AWAY_RATE, dt));
    }
    this.prevYaw = e.yaw;
    this.prevOy = e.oy;
    this.prevRoll = e.roll;
  }

  private hatAwayTarget(e: BotEngine): number {
    return e.actAmt > ACT_WORN && actCoversHead(e.shown) ? 1 : 0;
  }

  /** How much of the pumpkin's orange shows on the body: it comes and goes with the outfit. */
  pumpkinAlpha(e: BotEngine): number {
    if (e.isMini || this.outfit !== "pumpkin") return 0;
    return Math.min(1, e.outfitPresence * 2.5) * (1 - e.morph);
  }

  /** The head the outfit is fitted to, following the act's turn of the head too. */
  head(e: BotEngine, R: number): Head | null {
    if (e.isMini || this.outfit === "none") return null;
    return makeHead(R, e.yaw + e.dYaw, e.pitch + e.dPitch, this.physDx, this.physDy);
  }

  /** Presence and morph for the layers; a hat lifts away for a head prop. */
  private state(e: BotEngine): OutfitState {
    const away = ON_HEAD.has(this.outfit) ? 1 - this.hatAway : 1;
    return { presence: e.outfitPresence * away, morph: e.morph };
  }

  drawBehind(x: CanvasRenderingContext2D, e: BotEngine, head: Head | null) {
    if (head) drawOutfitBehind(x, this.outfit, head, this.state(e));
  }

  drawFront(x: CanvasRenderingContext2D, e: BotEngine, head: Head | null) {
    if (head) drawOutfitFront(x, this.outfit, head, this.state(e));
  }
}

/** The pumpkin's orange over the body, at `alpha`. */
export function fillPumpkin(x: CanvasRenderingContext2D, body: Path2D, [rx, ry]: [number, number], alpha: number) {
  const pg = x.createLinearGradient(rx * 0.7, -ry * 0.85, -rx * 0.8, ry * 0.9);
  pg.addColorStop(0, PUMPKIN_BODY[0]);
  pg.addColorStop(1, PUMPKIN_BODY[1]);
  x.globalAlpha = alpha;
  x.fillStyle = pg;
  x.fill(body);
}
