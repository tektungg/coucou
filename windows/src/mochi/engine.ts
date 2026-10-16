// Mochi — direct port of NotchBuddy/Sources/App/BotEngine.swift to Canvas 2D.
// Same constants, same tweens, same easings, same particles. The only intentional
// difference is the `happy`/`wink` eye arc, which follows the prototype
// (design/prototype/notch-buddy.html, the visual source of truth) — the Swift
// arc angles produce a different shape.

import { Ease, lerp, type EaseFn } from "../core/anim";
import { Sound } from "../core/sound";
import type { BotEmoteName, BotStateName } from "../core/layout";
import {
  actFloatsNotes, isOneShot, noteDue, actBursts, actEye, actKey, actPitchFloor, actPose, actProps,
  type Act, type Props,
} from "./acts";
import { BODY_RY } from "./geometry";
import { drawEyes, drawMouth } from "./engineFace";
import { drawBadge, drawParticles } from "./engineOverlay";
import { OutfitRig, fillPumpkin } from "./engineOutfit";
import { drawHandsBehind, drawProps } from "./engineProps";
import type { Outfit } from "./wardrobe";
import { BASE_BOTTOM, BASE_TOP, bodyPath, mix3, now, rgba } from "./engineShapes";
import { BOT_STATES, EMOTE_EYE, type BotStateCfg } from "./engineStates";

export { BOT_STATES, STATE_SOUND } from "./engineStates";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EyeShape =
  | "pill" | "wide" | "dot" | "line" | "flat" | "happy" | "closed"
  | "spiral" | "heart" | "star" | "tired" | "wink" | "cup";

export type BadgeKind = "dots" | "bang" | "question" | "dot";

export interface Badge {
  kind: BadgeKind;
  color: RGB;
}

export type RGB = readonly [number, number, number]; // components 0…1

export type TweenKey = readonly [target: number, durationMs: number, ease: EaseFn];

interface Tween {
  prop: PropKey;
  keys: TweenKey[];
  index: number;
  from: number;
  startMs: number;
  onComplete?: () => void;
}

type PropKey =
  | "yaw" | "pitch" | "roll" | "tilt" | "open" | "sx" | "sy"
  | "oy" | "ox" | "tint" | "morph" | "hands" | "blush" | "es" | "badgeS"
  | "outfitPresence";

interface Particle {
  type: "heart" | "star" | "spark" | "sweat" | "z" | "note";
  x: number; y: number; vx: number; vy: number;
  age: number; life: number; rot: number; size: number;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

export function hexToRGB(hex: string): RGB {
  const h = hex.replace("#", "");
  const v = parseInt(h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}


// ── Engine ────────────────────────────────────────────────────────────────────

export class BotEngine {
  isMini = false;
  /** Solid body colour for mini bots / integration pills (null = Mochi gradient). */
  bodyColor: RGB | null = null;

  // Animated state (BotEngine `s`)
  yaw = 0; pitch = 0; roll = 0; tilt = 0; open = 1;
  sx = 1; sy = 1; oy = 0; ox = 0;
  tint = 0; morph = 0; hands = 0; blush = 0; es = 1; badgeS = 0;

  /** The outfit's presence, 0 = gone, 1 = on: tweened like the rest (engineOutfit.ts). */
  outfitPresence = 0;
  /** What Mochi wears (the main Mochi only, minis never wear one). */
  readonly rig = new OutfitRig();

  // Targets
  tgYaw = 0; tgPitch = 0; tgTilt = 0; tgSy = 1; tgSx = 1; tgEs = 1;

  /** Extra canvas height above the body so hearts can fly out without clipping. */
  particleOverhang = 0;

  // Mouth spring (fraction of R)
  slotH = 0; slotHTarget = 0; slotHVel = 0; isChewing = false;

  col: RGB = BOT_STATES.idle.color;
  colT: RGB = BOT_STATES.idle.color;

  state: BotStateName = "idle";
  cfg: BotStateCfg = BOT_STATES.idle;

  eyeOverride: EyeShape | null = null;
  eyeOverrideUntil = 0;
  permanentEye: EyeShape | null = null;
  permanentEmote: BotEmoteName | null = null;
  miniNextBehavior = 0;

  badge: Badge | null = null;
  private badgeKey = "none";
  private badgeToken = 0;

  private tweens = new Map<PropKey, Tween>();
  private locks = new Set<PropKey>();
  particles: Particle[] = [];

  lookX = 0;
  lookY = 0;

  lastTime = now();
  private t0 = now() - Math.random() * 5;
  private nextBlink = now() + 1.5 + Math.random() * 2;
  waveUntil = 0;
  waveStart = 0;
  private greetToken = 0;
  private lastAmbient = 0;
  private slapTimes: number[] = [];
  private miniLookTarget = { x: 0, y: 0 };
  private miniLookNextTime = 0;

  /** The pill's act (mochi/acts.ts), set by the island and the mini bots every frame. */
  act: Act | null = null;
  /** The act being drawn, which lags `act` so a swap fades out then in, and its 0…1 fade. */
  shown: Act | null = null;
  actAmt = 0;
  // Act pose × actAmt, added on top of the regular animation at draw time.
  private dOx = 0; private dOy = 0; private dTilt = 0;
  // Read by engineFace.ts / engineProps.ts at draw time.
  dYaw = 0; dPitch = 0;
  private dSx = 1; private dSy = 1;
  dHandL = 0; dHandR = 0;
  actEyeShape: EyeShape | null = null;
  props: Props = { show: 1, flap: 0, fall: 0, stroke: 0 };
  private lastDanceT = 0;
  lastActAge = 0;

  /** Plays `act` at full strength right away (a view rebuilt in the middle of it). */
  setActNow(act: Act | null) {
    this.act = act;
    this.shown = act;
    this.actAmt = act ? 1 : 0;
    this.lastActAge = act && isOneShot(act.name) ? (performance.now() - act.at) / 1000 : 0;
  }

  /** Fired when three slaps land inside 1.7 s (→ dizzy + confused view). */
  onDizzy: (() => void) | null = null;

  // ── Public API ──────────────────────────────────────────────────────────────

  setState(next: BotStateName, force = false) {
    if (this.state === next && !force) return;
    const prev = this.state;
    this.state = next;
    this.cfg = BOT_STATES[next];
    this.colT = this.cfg.color;
    if (!this.locks.has("tint")) this.tint = this.cfg.tint;
    if (!this.locks.has("tilt")) this.tgTilt = this.cfg.tilt;
    this.setBadge(this.cfg.badge);

    switch (next) {
      case "finished":
        this.doRoll(950, 1);
        setTimeout(() => this.emit("spark", 5), 500);
        break;
      case "error":
        this.anim("ox", [
          [0.08, 50, Ease.out], [-0.08, 70, Ease.inOut],
          [0.05, 70, Ease.inOut], [0, 90, Ease.out],
        ]);
        break;
      case "approval":
        this.anim("oy", [[-0.2, 150, Ease.out], [0, 300, Ease.back]]);
        break;
      case "dizzy":
        this.doRoll(1300, 2);
        break;
      case "question":
        this.blink();
        break;
      case "ratelimit":
        this.emit("sweat", 1);
        break;
      default:
        if (prev !== "idle" || next !== "idle") this.blink();
    }
  }

  setBadge(b: Badge | null) {
    const key = b ? `${b.kind}-${b.color.join(",")}` : "none";
    if (key === this.badgeKey) return;
    this.badgeKey = key;
    const tok = ++this.badgeToken;
    this.anim("badgeS", [[0, 90, Ease.inOut]]);
    setTimeout(() => {
      if (tok !== this.badgeToken) return;
      this.badge = b;
      if (b) this.anim("badgeS", [[1, 280, Ease.back]]);
    }, 100);
  }

  blink() {
    if (this.locks.has("open")) return;
    this.anim("open", [[0.06, 70, Ease.inOut], [1, 130, Ease.out]]);
  }

  squash() {
    this.rig.kick(0, 0.6);
    this.anim("sy", [[0.78, 70, Ease.out], [1.1, 130, Ease.out], [1, 170, Ease.inOut]]);
    this.anim("sx", [[1.16, 70, Ease.out], [0.95, 130, Ease.out], [1, 170, Ease.inOut]]);
  }

  /** Mailbox swallow — opens the slot, chews, then closes. */
  gulp() {
    this.slotHTarget = 0.42;
    setTimeout(() => {
      this.slotHTarget = 0;
      this.isChewing = true;
      setTimeout(() => { this.isChewing = false; }, 800);
    }, 460);
    this.anim("sy", [[0.78, 80, Ease.out], [1.18, 130, Ease.out], [1, 220, Ease.back]]);
    this.anim("sx", [[1.28, 80, Ease.out], [0.92, 130, Ease.out], [1, 220, Ease.back]]);
    this.blink();
  }

  slap() {
    this.interruptGreet();
    if (this.state === "dizzy") return;
    const t = now();
    this.slapTimes = this.slapTimes.filter((s) => t - s < 1.7);
    this.slapTimes.push(t);
    Sound.play("slap");
    this.squash();
    this.rig.kick(Math.random() < 0.5 ? 0.7 : -0.7, -1.2);
    if (this.slapTimes.length >= 3) {
      this.slapTimes = [];
      this.onDizzy?.();
    } else {
      this.eyeOverride = "line";
      this.eyeOverrideUntil = t + 0.8;
      setTimeout(() => Sound.play("annoyed"), 60);
    }
  }

  doRoll(durationMs: number, turns: number) {
    this.roll = 0;
    this.anim("roll", [[Math.PI * 2 * turns, durationMs, Ease.inOut]], () => { this.roll = 0; });
  }

  /** Peek wave — the "coucou". Timings from BotEngine.greet(). */
  greet() {
    const t = now();
    const tok = ++this.greetToken;
    this.waveStart = t + 0.45;
    this.waveUntil = t + 1.55;
    this.rig.kick(0.2, 0);

    this.eyeOverride = "happy";
    this.eyeOverrideUntil = t + 2.0;
    this.anim("oy", [[-0.06, 220, Ease.out], [0.0, 220, Ease.back]]);

    setTimeout(() => {
      if (this.greetToken !== tok) return;
      this.anim("hands", [[1, 280, Ease.out]]);
      this.anim("sy", [[0.95, 100, Ease.out], [1.0, 260, Ease.back]]);
      this.anim("sx", [[1.04, 100, Ease.out], [1.0, 260, Ease.back]]);
      Sound.play("greet");
    }, 250);

    setTimeout(() => { if (this.greetToken === tok) this.blink(); }, 550);
    setTimeout(() => { if (this.greetToken === tok) this.blink(); }, 1500);
    setTimeout(() => {
      if (this.greetToken !== tok) return;
      this.waveUntil = 0;
      this.anim("hands", [[0, 200, Ease.inOut]]);
    }, 1550);
    setTimeout(() => {
      if (this.greetToken !== tok) return;
      this.eyeOverride = "happy";
      this.eyeOverrideUntil = now() + 0.3;
    }, 1750);
  }

  interruptGreet() {
    if (this.hands <= 0.01 && now() >= this.waveUntil) return;
    this.greetToken++;
    this.waveUntil = 0;
    this.waveStart = 0;
    this.anim("hands", [[0, 150, Ease.inOut]]);
  }

  setPermanentEmote(emote: BotEmoteName | null) {
    this.permanentEmote = emote;
    if (emote === "wink") {
      this.miniNextBehavior = now() + 0.8 + Math.random() * 1.7;
      return;
    }
    this.permanentEye = emote ? EMOTE_EYE[emote] : null;
    if (this.permanentEye) {
      this.eyeOverride = this.permanentEye;
      this.eyeOverrideUntil = Number.POSITIVE_INFINITY;
    } else if (this.eyeOverrideUntil === Number.POSITIVE_INFINITY) {
      this.eyeOverride = null;
      this.eyeOverrideUntil = 0;
    }
    this.miniNextBehavior = now() + 0.8 + Math.random() * 1.7;
  }

  triggerEmote(emote: BotEmoteName, duration = 1.8) {
    const t = now();
    this.eyeOverride = EMOTE_EYE[emote];
    this.eyeOverrideUntil = t + duration;

    switch (emote) {
      case "love":
        this.anim("blush", [
          [1, 300, Ease.out], [1, (duration - 0.6) * 1000, Ease.lin], [0, 300, Ease.inOut],
        ]);
        this.emit("heart", 4);
        this.anim("oy", [[-0.1, 160, Ease.out], [0, 300, Ease.back]]);
        break;
      case "surprised":
        this.anim("oy", [[-0.3, 140, Ease.out], [0, 380, Ease.back]]);
        this.anim("es", [[1.25, 120, Ease.out], [1, 500, Ease.inOut]]);
        break;
      case "proud":
        this.emit("star", 5);
        this.anim("tilt", [
          [-0.14, 220, Ease.out], [-0.14, (duration - 0.5) * 1000, Ease.lin], [0, 280, Ease.inOut],
        ]);
        this.anim("blush", [
          [0.7, 250, Ease.out], [0.7, (duration - 0.5) * 1000, Ease.lin], [0, 300, Ease.inOut],
        ]);
        break;
      case "wink":
        this.anim("tilt", [
          [0.12, 160, Ease.out], [0.12, (duration - 0.4) * 1000, Ease.lin], [0, 240, Ease.inOut],
        ]);
        break;
      case "yawn":
        this.anim("sy", [[1.12, 500, Ease.inOut], [1, 500, Ease.inOut]]);
        this.anim("sx", [[0.94, 500, Ease.inOut], [1, 500, Ease.inOut]]);
        setTimeout(() => { this.eyeOverride = "closed"; this.emit("z", 2); }, 700);
        break;
      case "happy":
        this.anim("blush", [[0.6, 200, Ease.out], [0, 600, Ease.inOut]]);
        break;
      case "annoyed":
        this.eyeOverride = "line";
        this.eyeOverrideUntil = t + 0.8;
        setTimeout(() => Sound.play("annoyed"), 60);
        break;
    }
  }

  emit(type: Particle["type"], count: number) {
    for (let i = 0; i < count; i++) {
      const isZ = type === "z";
      this.particles.push({
        type,
        x: (Math.random() - 0.5) * 0.9 + (isZ ? 0.55 : 0),
        y: -0.7 - Math.random() * 0.2,
        vx: (Math.random() - 0.5) * 0.35 + (isZ ? 0.18 : 0),
        vy: -(0.45 + Math.random() * 0.35),
        age: -i * 0.14,
        life: 1.3 + Math.random() * 0.5,
        rot: Math.random() * Math.PI * 2,
        size: 0.15 + Math.random() * 0.08,
      });
    }
  }

  animateMorph(target: number, durationMs?: number) {
    const dur = durationMs ?? (target > 0.5 ? 550 : 650);
    this.anim("morph", [[target, dur, Ease.inOut]]);
  }

  resetMorph() {
    this.tweens.delete("morph");
    this.locks.delete("morph");
    this.morph = 0;
  }

  /** Dresses Mochi; animated, the old outfit leaves and the new one drops in. */
  setOutfit(next: Outfit, animated = true) {
    this.rig.set(this, next, animated);
  }

  /** Stops a tween where it is, and frees its property for the springs. */
  stopTween(prop: PropKey) {
    this.tweens.delete(prop);
    this.locks.delete(prop);
  }

  /** True while anything is still moving — lets the island stop its RAF loop. */
  get busy(): boolean {
    return this.animating || this.chasing || this.rig.busy(this);
  }

  /** A tween, a particle, a looping state, a mini bot or an act keeps him moving. */
  private get animating(): boolean {
    const cfg = this.cfg;
    const loops = cfg.bounces || cfg.scans || cfg.breathes || cfg.zz || cfg.sweat;
    return this.tweens.size > 0 || this.particles.length > 0 || loops ||
      this.isMini || this.act != null || this.actAmt > 0.001;
  }

  /** Something still easing toward its target: the pose, the mouth slot, the colour. */
  private get chasing(): boolean {
    const off = (a: number, b: number, eps: number) => Math.abs(a - b) > eps;
    const pose = [[this.tgYaw, this.yaw], [this.tgPitch, this.pitch], [this.tgTilt, this.tilt],
      [this.tgSy, this.sy], [this.tgSx, this.sx], [this.tgEs, this.es]];
    const colour = [0, 1, 2].some((i) => off(this.col[i], this.colT[i], 0.003));
    const slot = this.slotH > 0.001 || Math.abs(this.slotHVel) > 0.001;
    return pose.some(([t, v]) => off(t, v, 0.002)) || slot || colour;
  }

  // ── Tweens ──────────────────────────────────────────────────────────────────

  anim(prop: PropKey, keys: TweenKey[], onComplete?: () => void) {
    this.tweens.set(prop, {
      prop, keys, index: 0, from: this[prop], startMs: performance.now(), onComplete,
    });
    this.locks.add(prop);
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  update(dt: number) {
    const n = now();
    this.stepTweens(performance.now());
    const t = n - this.t0;
    this.aimLook(n, t);
    this.tgTilt = this.cfg.tilt;
    if (n > this.waveStart && n < this.waveUntil) {
      const wt = n - this.waveStart;
      this.tgTilt = -0.06 + Math.sin(2 * Math.PI * 1.2 * wt) * 0.07;
    }
    const kGen = 1 - Math.pow(0.0008, dt);
    this.aimBody(t, kGen);
    if (this.isMini && n > this.miniNextBehavior) this.doMiniBehaviorLoop();
    this.followTargets(dt, kGen);
    this.col = mix3(this.col, this.colT, 1 - Math.pow(0.002, dt));
    this.blinkAndAmbient(n);
    this.updateAct(dt, t);
    for (const p of this.particles) p.age += dt;
    this.particles = this.particles.filter((p) => p.age < p.life);
    this.stepMouth(dt);
    this.rig.step(this, dt);
    this.lastTime = n;
  }

  /** Every running tween one frame further; finished ones call back. */
  private stepTweens(nowMs: number) {
    for (const tw of [...this.tweens.values()]) {
      const k = tw.keys[tw.index];
      const p = Math.min(1, Math.max(0, (nowMs - tw.startMs) / k[1]));
      this[tw.prop] = tw.from + (k[0] - tw.from) * k[2](p);
      if (p >= 1) {
        tw.from = k[0];
        tw.index += 1;
        tw.startMs = nowMs;
        if (tw.index >= tw.keys.length) {
          this.tweens.delete(tw.prop);
          this.locks.delete(tw.prop);
          tw.onComplete?.();
        }
      }
    }
  }

  /** Where the head turns: the pointer, the state's own look, a scan, a mini's wander. */
  private aimLook(n: number, t: number) {
    let ty = this.lookX * 0.62;
    let tp = this.lookY * 0.5;
    if (this.cfg.look) {
      ty = ty * 0.35 + this.cfg.look[0] * 0.55;
      tp = tp * 0.3 + this.cfg.look[1] * 0.5;
    }
    if (this.cfg.scans) {
      ty = Math.sin(t * 2.6) * 0.6;
      tp = -0.06;
    }
    if (this.state === "sleeping") { ty = 0; tp = -0.14; }
    if (this.state === "dizzy") { ty = Math.sin(t * 9) * 0.25; }
    // Mini bots never follow the mouse — they wander.
    if (this.wanders) [ty, tp] = this.miniWander(n);
    const floor = this.shown ? actPitchFloor(this.shown.name) : null;
    if (floor !== null && tp < floor) tp = lerp(tp, floor, this.actAmt);
    this.tgYaw = ty;
    this.tgPitch = tp;
  }

  /** A mini bot left to itself: no state that sets where it looks. */
  private get wanders(): boolean {
    const held = this.cfg.look || this.cfg.scans || this.state === "sleeping" || this.state === "dizzy";
    return this.isMini && !held;
  }

  /** A mini bot's next look, picked every half second to two seconds. */
  private miniWander(n: number): [number, number] {
    if (n > this.miniLookNextTime) {
      this.miniLookTarget = {
        x: -0.88 + Math.random() * 1.76,
        y: -0.55 + Math.random() * 1.0,
      };
      this.miniLookNextTime = n + 0.5 + Math.random() * 1.5;
    }
    return [this.miniLookTarget.x * 0.62, this.miniLookTarget.y * 0.5];
  }

  /** The bounce and the breathing the body follows. */
  private aimBody(t: number, kGen: number) {
    const bounce = this.cfg.bounces ? -Math.abs(Math.sin(t * 5.2)) * 0.07 : 0;
    if (!this.locks.has("oy")) this.oy += (bounce - this.oy) * kGen;
    if (this.cfg.breathes) {
      const amp = this.isMini ? 0.07 : 0.035;
      this.tgSy = 1 + Math.sin(t * 1.8) * amp;
      this.tgSx = 1 - Math.sin(t * 1.8) * amp * 0.57;
    } else if (this.isMini) {
      this.tgSy = 1 + Math.sin(t * 2.2) * 0.04;
      this.tgSx = 1 - Math.sin(t * 2.2) * 0.02;
    } else {
      this.tgSy = 1;
      this.tgSx = 1;
    }
  }

  /** Each animated value eases toward its target, unless a tween holds it. */
  private followTargets(dt: number, kGen: number) {
    const kLook = 1 - Math.pow(0.0025, dt);
    if (!this.locks.has("yaw")) this.yaw += (this.tgYaw - this.yaw) * kLook;
    if (!this.locks.has("pitch")) this.pitch += (this.tgPitch - this.pitch) * kLook;
    if (!this.locks.has("tilt")) this.tilt += (this.tgTilt - this.tilt) * kGen;
    if (!this.locks.has("sy")) this.sy += (this.tgSy - this.sy) * kGen;
    if (!this.locks.has("sx")) this.sx += (this.tgSx - this.sx) * kGen;
    if (!this.locks.has("es")) this.es += (this.tgEs - this.es) * kGen;
  }

  /** Blinks now and then, ends a timed eye, and lets the state's z's and sweat out. */
  private blinkAndAmbient(n: number) {
    if (n > this.nextBlink) this.blinkNow(n);
    if (this.eyeOverride && n > this.eyeOverrideUntil) {
      this.eyeOverride = this.permanentEye;
      if (this.permanentEye) this.eyeOverrideUntil = Number.POSITIVE_INFINITY;
    }
    if (n - this.lastAmbient > 1.3) {
      this.lastAmbient = n;
      if (this.cfg.zz) this.emit("z", 1);
      if (!this.isMini && this.cfg.sweat && Math.random() < 0.5) this.emit("sweat", 1);
    }
  }

  /** A blink (sometimes two), unless asleep or dizzy, and when the next one comes. */
  private blinkNow(n: number) {
    if (this.state !== "sleeping" && this.state !== "dizzy") {
      this.blink();
      if (Math.random() < 0.22) setTimeout(() => this.blink(), 230);
    }
    this.nextBlink = n + 2.2 + Math.random() * 3.2;
  }

  /** Mouth slot spring: ω₀ = 2π/0.25, ζ = 0.6. */
  private stepMouth(dt: number) {
    const omega = (2 * Math.PI) / 0.25;
    const zeta = 0.6;
    const acc = omega * omega * (this.slotHTarget - this.slotH) - 2 * zeta * omega * this.slotHVel;
    this.slotHVel += acc * dt;
    this.slotH = Math.max(0, this.slotH + this.slotHVel * dt);
  }

  private updateAct(dt: number, t: number) {
    const target = this.act;
    const same = actKey(target) === actKey(this.shown);
    if (!same && this.actAmt <= 0.02) {
      // A one-shot owns the eyes: drop the "finished" eye roll it arrives with.
      if (target && isOneShot(target.name)) this.cancelRoll();
      this.shown = target;
      this.lastActAge = 0;
    } else if (same && target) {
      this.shown = target; // live variant (the mic muted mid-call)
    }
    const shown = this.shown;
    const want = shown && actKey(shown) === actKey(target) ? 1 : 0;
    // The Music states ease in and out over about a second; other acts swap fast
    // (one-shots pop their props and fade their own pose out at the end).
    const slow = shown?.name === "music" && (want === 1 || target == null);
    this.actAmt += (want - this.actAmt) * (1 - Math.pow(slow ? 0.02 : 0.0005, dt));
    if (want === 0 && this.actAmt < 0.001) {
      this.actAmt = 0;
      this.shown = null;
    }

    const g = this.actAmt;
    if (this.shown && g > 0) {
      const a = this.shown;
      const oneShot = isOneShot(a.name);
      const age = oneShot ? (performance.now() - a.at) / 1000 : t;
      const p = actPose(a.name, a.variant, age, t);
      this.dOx = p.ox * g; this.dOy = p.oy * g; this.dTilt = p.tilt * g;
      this.dYaw = p.yaw * g; this.dPitch = p.pitch * g;
      this.dSx = lerp(1, p.sx, g); this.dSy = lerp(1, p.sy, g);
      this.dHandL = p.handL * g; this.dHandR = p.handR * g;
      this.actEyeShape = g > 0.5 ? actEye(a.name, a.variant, age) : null;
      this.props = actProps(a.name, a.variant, age);
      if (oneShot && !this.isMini) {
        for (const b of actBursts(a.name, a.variant, this.lastActAge, age)) this.emit(b.type, b.count);
      }
      this.lastActAge = age;
    } else {
      this.dOx = this.dOy = this.dTilt = this.dYaw = this.dPitch = this.dHandL = this.dHandR = 0;
      this.dSx = this.dSy = 1;
      this.actEyeShape = null;
    }
    if (actFloatsNotes(this.shown) && want && !this.isMini && g > 0.6 && noteDue(this.lastDanceT, t)) {
      this.emit("note", 1);
    }
    this.lastDanceT = t;
  }

  private cancelRoll() {
    this.tweens.delete("roll");
    this.locks.delete("roll");
    this.roll = 0;
  }

  private doMiniBehaviorLoop() {
    const n = now();
    switch (this.permanentEmote) {
      case "happy":
        if (this.locks.has("oy")) { this.miniNextBehavior = n + 0.4; return; }
        this.anim("oy", [[-0.3, 120, Ease.out], [0.03, 200, Ease.inOut], [0, 160, Ease.back]]);
        this.anim("sy", [[0.82, 80, Ease.out], [1.18, 130, Ease.out], [0.88, 160, Ease.inOut], [1, 200, Ease.back]]);
        this.anim("sx", [[1.15, 80, Ease.out], [0.88, 130, Ease.out], [1.06, 160, Ease.inOut], [1, 200, Ease.back]]);
        this.miniNextBehavior = n + 2.2 + Math.random() * 1.2;
        break;
      case "annoyed":
        if (this.locks.has("yaw")) { this.miniNextBehavior = n + 0.5; return; }
        this.anim("yaw", [
          [-0.65, 50, Ease.out], [0.65, 90, Ease.inOut], [-0.5, 80, Ease.inOut],
          [0.4, 75, Ease.inOut], [-0.2, 70, Ease.inOut], [0, 140, Ease.out],
        ]);
        this.miniNextBehavior = n + 3.0 + Math.random() * 2.5;
        break;
      case "wink":
        this.eyeOverride = "wink";
        this.eyeOverrideUntil = n + 0.55;
        this.anim("tilt", [[0.13, 100, Ease.out], [0.13, 320, Ease.lin], [0, 200, Ease.inOut]]);
        this.miniNextBehavior = n + 2.2 + Math.random() * 2.0;
        break;
      case "love":
        this.emit("heart", 2);
        this.anim("tilt", [[-0.1, 180, Ease.out], [0.1, 340, Ease.inOut], [0, 220, Ease.inOut]]);
        this.miniNextBehavior = n + 2.6 + Math.random() * 1.5;
        break;
      default:
        this.miniNextBehavior = n + 3.0 + Math.random() * 2.0;
    }
  }

  // ── Draw ────────────────────────────────────────────────────────────────────

  /**
   * Draws hands, body, blush, eyes, mouth, badge and particles into a canvas of
   * `w`×`h` CSS pixels (the caller has already applied the DPR transform).
   */
  draw(x: CanvasRenderingContext2D, W: number, H: number) {
    const R = W * 0.3;
    const rx = R * 1.14;
    const ry = R * BODY_RY;
    const cx = W / 2 + (this.ox + this.dOx) * R;
    const cy = H / 2 + this.particleOverhang / 2 + (this.oy + this.dOy) * R + R * 0.06;
    const tilt = this.tilt + this.dTilt;
    const sx = this.sx * this.dSx;
    const sy = this.sy * this.dSy;

    // With an outfit on, a roll turns the whole character, hat included, as
    // one piece instead of rolling the eyes over the body (BotCanvasView, macOS).
    x.save();
    if (this.rig.rigidRoll(this) && Math.abs(this.roll) > 0.001) {
      x.translate(cx, cy);
      x.rotate(this.roll);
      x.translate(-cx, -cy);
    }
    drawHandsBehind(this, x, { R, rx, ry, cx, cy, tilt, sx, sy });
    x.save();
    x.translate(cx, cy);
    if (tilt !== 0) x.rotate(tilt);
    x.scale(sx, sy);
    this.drawCharacter(x, { R, rx, ry });
    x.restore();
    x.restore();

    // The badge sits where the props go (headband, hat, box); the act says it instead.
    if (this.badge && this.badgeS > 0.01 && this.morph < 0.25 && this.actAmt < 0.5) {
      drawBadge(this, x, this.badge, { R, cx, cy });
    }
    drawParticles(this, x, { R, cx, cy });
  }

  /** In body space: the outfit's back, the body, blush, eyes, mouth, props, the outfit's front. */
  private drawCharacter(x: CanvasRenderingContext2D, dims: { R: number; rx: number; ry: number }) {
    const { R, rx, ry } = dims;
    const head = this.rig.head(this, R);
    this.rig.drawBehind(x, this, head);
    const body = bodyPath(rx, ry, R, this.morph);
    this.drawBody(x, body, R, rx, ry);
    this.drawBlush(x, body, dims);
    drawEyes(this, x, body, dims);
    if (this.morph > 0.05) drawMouth(this, x, body, R);
    const propAmt = this.actAmt * Math.max(0, 1 - this.morph * 2);
    if (this.shown && propAmt > 0.01) drawProps(this, x, dims, this.shown, propAmt);
    this.rig.drawFront(x, this, head);
  }

  private drawBlush(x: CanvasRenderingContext2D, body: Path2D, { R, rx, ry }: { R: number; rx: number; ry: number }) {
    const blushVal = Math.max(this.blush, this.tint * 0.5) * (1 - this.morph);
    if (blushVal <= 0.01) return;
    x.save();
    x.clip(body);
    const yOffset = Math.sin(this.yaw + this.dYaw) * rx * 0.8;
    x.fillStyle = `rgba(255,120,150,${0.5 * blushVal})`;
    for (const sd of [-1, 1]) {
      x.beginPath();
      x.ellipse(sd * rx * 0.55 + yOffset, ry * 0.2, R * 0.17, R * 0.1, 0, 0, Math.PI * 2);
      x.fill();
    }
    x.restore();
  }

  private drawBody(x: CanvasRenderingContext2D, body: Path2D, R: number, rx: number, ry: number) {
    const pumpkin = this.rig.pumpkinAlpha(this);
    if (this.bodyColor) {
      // Mini bots: flat solid fill — no gradient, no reflection, no highlight
      x.fillStyle = rgba(this.bodyColor, 1);
      x.fill(body);
      if (pumpkin <= 0.001) return;
    } else {
      const g = x.createLinearGradient(rx * 0.7, -ry * 0.85, -rx * 0.8, ry * 0.9);
      g.addColorStop(0, rgba(BASE_TOP));
      g.addColorStop(1, rgba(BASE_BOTTOM));
      x.fillStyle = g;
      x.fill(body);
    }
    x.save();
    if (pumpkin > 0.001) {
      fillPumpkin(x, body, [rx, ry], pumpkin);
      // A flat-coloured body only gets the shading while it is a pumpkin.
      x.globalAlpha = this.bodyColor ? pumpkin : 1;
    }
    this.shadeBody(x, body, R, [rx, ry]);
    x.restore();
  }

  /** The state's tint from below, the edge shadow and the highlight. */
  private shadeBody(x: CanvasRenderingContext2D, body: Path2D, R: number, [rx, ry]: [number, number]) {
    const effectiveTint = this.tint * (1 - this.morph);
    if (effectiveTint > 0.01) {
      const tg = x.createLinearGradient(0, ry, 0, -ry);
      tg.addColorStop(0, rgba(this.col, 0.72 * effectiveTint));
      tg.addColorStop(1, rgba(this.col, 0));
      x.fillStyle = tg;
      x.fill(body);
    }

    const sh = x.createRadialGradient(0, 0, R * 0.15, 0, 0, R * 1.25);
    sh.addColorStop(0, "rgba(0,0,0,0)");
    sh.addColorStop(0.6, "rgba(0,0,0,0)");
    sh.addColorStop(1, "rgba(0,0,0,0.2)");
    x.fillStyle = sh;
    x.fill(body);

    const hl = x.createRadialGradient(rx * 0.34, -ry * 0.46, 0, rx * 0.34, -ry * 0.46, R * 0.42);
    hl.addColorStop(0, "rgba(255,255,255,0.55)");
    hl.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = hl;
    x.fill(body);
  }
}
