// Mochi — direct port of NotchBuddy/Sources/App/BotEngine.swift to Canvas 2D.
// Same constants, same tweens, same easings, same particles. The only intentional
// difference is the `happy`/`wink` eye arc, which follows the prototype
// (design/prototype/notch-buddy.html, the visual source of truth) — the Swift
// arc angles produce a different shape.

import { Ease, lerp, type EaseFn } from "../core/anim";
import { Sound } from "../core/sound";
import type { BotEmoteName, BotStateName } from "../core/layout";
import {
  ACT_HANDS, isOneShot, noteDue, actBursts, actEye, actKey, actPitchFloor, actPose, actProps, type Act, type Props,
} from "./acts";
import { BODY_RY, ENVELOPE, EYE_H, EYE_P, EYE_SP, EYE_W, envelopeParts } from "./geometry";

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
  | "oy" | "ox" | "tint" | "morph" | "hands" | "blush" | "es" | "badgeS";

interface BotStateCfg {
  color: RGB;
  tint: number;
  eye: EyeShape;
  badge: Badge | null;
  bounces: boolean;
  scans: boolean;
  breathes: boolean;
  zz: boolean;
  sweat: boolean;
  look: readonly [number, number] | null;
  tilt: number;
}

interface Particle {
  type: "heart" | "star" | "spark" | "sweat" | "z" | "note";
  x: number; y: number; vx: number; vy: number;
  age: number; life: number; rot: number; size: number;
}

// ── Constants (MochiConst / PISTES.mochi) ─────────────────────────────────────

const BASE_TOP: RGB = [0.929, 0.929, 0.937]; // #EDEDEF
const BASE_BOTTOM: RGB = [0.769, 0.773, 0.792]; // #C4C5CA
const INK = "rgb(26,20,18)"; // #1A1412
const MINI_INK = "rgb(16,19,26)"; // #10131A
const GRAPHITE = "rgb(54,58,69)"; // act props: headband, boom mic

const C = {
  idle: [0.902, 0.914, 0.933] as RGB,
  working: [0.231, 0.62, 1] as RGB,
  thinking: [0.545, 0.361, 0.965] as RGB,
  searching: [0.388, 0.396, 0.949] as RGB,
  approval: [0.961, 0.647, 0.141] as RGB,
  question: [0.133, 0.827, 0.933] as RGB,
  error: [0.957, 0.314, 0.369] as RGB,
  finished: [0.204, 0.831, 0.6] as RGB,
  ratelimit: [0.984, 0.573, 0.235] as RGB,
  sleeping: [0.58, 0.635, 0.722] as RGB,
  dizzy: [0.957, 0.447, 0.714] as RGB,
};

const base = {
  bounces: false, scans: false, breathes: false, zz: false, sweat: false,
  look: null, tilt: 0,
};

export const BOT_STATES: Record<BotStateName, BotStateCfg> = {
  idle: { ...base, color: C.idle, tint: 0, eye: "pill", badge: null },
  working: { ...base, color: C.working, tint: 0.72, eye: "pill", badge: { kind: "dots", color: C.working } },
  thinking: { ...base, color: C.thinking, tint: 0.72, eye: "pill", badge: { kind: "dots", color: C.thinking }, look: [0.55, 0.55] },
  searching: { ...base, color: C.searching, tint: 0.72, eye: "pill", badge: { kind: "dots", color: C.searching }, scans: true },
  approval: { ...base, color: C.approval, tint: 0.78, eye: "wide", badge: { kind: "bang", color: C.approval }, bounces: true },
  question: { ...base, color: C.question, tint: 0.75, eye: "pill", badge: { kind: "question", color: C.question }, tilt: 0.17 },
  error: { ...base, color: C.error, tint: 0.78, eye: "flat", badge: { kind: "dot", color: C.error } },
  finished: { ...base, color: C.finished, tint: 0.35, eye: "happy", badge: { kind: "dot", color: C.finished } },
  ratelimit: { ...base, color: C.ratelimit, tint: 0.72, eye: "tired", badge: { kind: "dot", color: C.ratelimit }, sweat: true },
  sleeping: { ...base, color: C.sleeping, tint: 0.32, eye: "closed", badge: null, breathes: true, zz: true },
  dizzy: { ...base, color: C.dizzy, tint: 0.7, eye: "spiral", badge: null },
};

/** State → sound, as in BotStateCfg.sound. */
export const STATE_SOUND: Partial<Record<BotStateName, string>> = {
  working: "work", thinking: "think", searching: "search", approval: "approval",
  question: "question", error: "error", finished: "finish", ratelimit: "rate",
  sleeping: "sleep", dizzy: "dizzy",
};

const EMOTE_EYE: Record<BotEmoteName, EyeShape> = {
  love: "heart", surprised: "dot", proud: "star", wink: "wink",
  yawn: "tired", happy: "happy", annoyed: "line",
};

// ── Small helpers ─────────────────────────────────────────────────────────────

const now = () => performance.now() / 1000;

export function hexToRGB(hex: string): RGB {
  const h = hex.replace("#", "");
  const v = parseInt(h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const rgba = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

const mix3 = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t),
];

function roundRectPath(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number) {
  const r = Math.max(0, Math.min(R, W / 2, H / 2));
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r);
  x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r);
  x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

function heartPath(x: CanvasRenderingContext2D, s: number) {
  x.beginPath();
  x.moveTo(0, s * 0.38);
  x.bezierCurveTo(-s * 1.05, -s * 0.15, -s * 0.5, -s * 0.95, 0, -s * 0.38);
  x.bezierCurveTo(s * 0.5, -s * 0.95, s * 1.05, -s * 0.15, 0, s * 0.38);
  x.closePath();
}

function starPath(x: CanvasRenderingContext2D, ro: number, ri: number) {
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    x.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  x.closePath();
}

const FONT = `system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif`;

// ── Engine ────────────────────────────────────────────────────────────────────

export class BotEngine {
  isMini = false;
  /** Solid body colour for mini bots / integration pills (null = Mochi gradient). */
  bodyColor: RGB | null = null;

  // Animated state (BotEngine `s`)
  yaw = 0; pitch = 0; roll = 0; tilt = 0; open = 1;
  sx = 1; sy = 1; oy = 0; ox = 0;
  tint = 0; morph = 0; hands = 0; blush = 0; es = 1; badgeS = 0;

  // Targets
  tgYaw = 0; tgPitch = 0; tgTilt = 0; tgSy = 1; tgSx = 1; tgEs = 1;

  /** Extra canvas height above the body so hearts can fly out without clipping. */
  particleOverhang = 0;

  // Mouth spring (fraction of R)
  slotH = 0; slotHTarget = 0; slotHVel = 0; isChewing = false;

  col: RGB = C.idle;
  colT: RGB = C.idle;

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
  private particles: Particle[] = [];

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
  private shown: Act | null = null;
  actAmt = 0;
  // Act pose × actAmt, added on top of the regular animation at draw time.
  private dOx = 0; private dOy = 0; private dTilt = 0; private dYaw = 0; private dPitch = 0;
  private dSx = 1; private dSy = 1; private dHandL = 0; private dHandR = 0;
  private actEyeShape: EyeShape | null = null;
  private props: Props = { show: 1, flap: 0, fall: 0, stroke: 0 };
  private lastDanceT = 0;
  private lastActAge = 0;

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

  /** True while anything is still moving — lets the island stop its RAF loop. */
  get busy(): boolean {
    return (
      this.tweens.size > 0 ||
      this.particles.length > 0 ||
      this.cfg.bounces || this.cfg.scans || this.cfg.breathes || this.cfg.zz || this.cfg.sweat ||
      this.isMini || this.act != null || this.actAmt > 0.001 ||
      Math.abs(this.tgYaw - this.yaw) > 0.002 ||
      Math.abs(this.tgPitch - this.pitch) > 0.002 ||
      Math.abs(this.tgTilt - this.tilt) > 0.002 ||
      Math.abs(this.tgSy - this.sy) > 0.002 ||
      Math.abs(this.tgSx - this.sx) > 0.002 ||
      Math.abs(this.tgEs - this.es) > 0.002 ||
      this.slotH > 0.001 || Math.abs(this.slotHVel) > 0.001 ||
      Math.abs(this.col[0] - this.colT[0]) > 0.003 ||
      Math.abs(this.col[1] - this.colT[1]) > 0.003 ||
      Math.abs(this.col[2] - this.colT[2]) > 0.003
    );
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
    const nowMs = performance.now();

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

    const t = n - this.t0;
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
    if (this.isMini && !this.cfg.look && !this.cfg.scans && this.state !== "sleeping" && this.state !== "dizzy") {
      if (n > this.miniLookNextTime) {
        this.miniLookTarget = {
          x: -0.88 + Math.random() * 1.76,
          y: -0.55 + Math.random() * 1.0,
        };
        this.miniLookNextTime = n + 0.5 + Math.random() * 1.5;
      }
      ty = this.miniLookTarget.x * 0.62;
      tp = this.miniLookTarget.y * 0.5;
    }

    const floor = this.shown ? actPitchFloor(this.shown.name) : null;
    if (floor !== null && tp < floor) tp = lerp(tp, floor, this.actAmt);

    this.tgYaw = ty;
    this.tgPitch = tp;
    this.tgTilt = this.cfg.tilt;

    if (n > this.waveStart && n < this.waveUntil) {
      const wt = n - this.waveStart;
      this.tgTilt = -0.06 + Math.sin(2 * Math.PI * 1.2 * wt) * 0.07;
    }

    const bounce = this.cfg.bounces ? -Math.abs(Math.sin(t * 5.2)) * 0.07 : 0;
    const kGen = 1 - Math.pow(0.0008, dt);
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

    if (this.isMini && n > this.miniNextBehavior) this.doMiniBehaviorLoop();

    const kLook = 1 - Math.pow(0.0025, dt);
    if (!this.locks.has("yaw")) this.yaw += (this.tgYaw - this.yaw) * kLook;
    if (!this.locks.has("pitch")) this.pitch += (this.tgPitch - this.pitch) * kLook;
    if (!this.locks.has("tilt")) this.tilt += (this.tgTilt - this.tilt) * kGen;
    if (!this.locks.has("sy")) this.sy += (this.tgSy - this.sy) * kGen;
    if (!this.locks.has("sx")) this.sx += (this.tgSx - this.sx) * kGen;
    if (!this.locks.has("es")) this.es += (this.tgEs - this.es) * kGen;

    this.col = mix3(this.col, this.colT, 1 - Math.pow(0.002, dt));

    if (n > this.nextBlink) {
      if (this.state !== "sleeping" && this.state !== "dizzy") {
        this.blink();
        if (Math.random() < 0.22) setTimeout(() => this.blink(), 230);
      }
      this.nextBlink = n + 2.2 + Math.random() * 3.2;
    }

    if (this.eyeOverride && n > this.eyeOverrideUntil) {
      this.eyeOverride = this.permanentEye;
      if (this.permanentEye) this.eyeOverrideUntil = Number.POSITIVE_INFINITY;
    }

    if (n - this.lastAmbient > 1.3) {
      this.lastAmbient = n;
      if (this.cfg.zz) this.emit("z", 1);
      if (!this.isMini && this.cfg.sweat && Math.random() < 0.5) this.emit("sweat", 1);
    }

    this.updateAct(dt, t);

    for (const p of this.particles) p.age += dt;
    this.particles = this.particles.filter((p) => p.age < p.life);

    // Mouth slot spring — ω₀ = 2π/0.25, ζ = 0.6
    const omega = (2 * Math.PI) / 0.25;
    const zeta = 0.6;
    const acc = omega * omega * (this.slotHTarget - this.slotH) - 2 * zeta * omega * this.slotHVel;
    this.slotHVel += acc * dt;
    this.slotH = Math.max(0, this.slotH + this.slotHVel * dt);

    this.lastTime = n;
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
    // The Music groove eases in and out over about a second; other acts swap fast
    // (one-shots pop their props and fade their own pose out at the end).
    const slow = shown?.name === "dance" && (want === 1 || target == null);
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
    if (this.shown?.name === "dance" && want && !this.isMini && g > 0.6 && noteDue(this.lastDanceT, t)) {
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

    this.drawHandsBehind(x, R, rx, ry, cx, cy, tilt, sx, sy);

    x.save();
    x.translate(cx, cy);
    if (tilt !== 0) x.rotate(tilt);
    x.scale(sx, sy);

    const body = this.bodyPath(rx, ry, R);
    this.drawBody(x, body, R, rx, ry);

    const blushVal = Math.max(this.blush, this.tint * 0.5) * (1 - this.morph);
    if (blushVal > 0.01) {
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

    this.drawEyes(x, body, R, rx, ry);
    if (this.morph > 0.05) this.drawMouth(x, body, R);
    const propAmt = this.actAmt * Math.max(0, 1 - this.morph * 2);
    if (this.shown && propAmt > 0.01) this.drawProps(x, R, rx, ry, this.shown, propAmt);

    x.restore();

    // The badge sits where the props go (headband, hat, box); the act says it instead.
    if (this.badge && this.badgeS > 0.01 && this.morph < 0.25 && this.actAmt < 0.5) {
      this.drawBadge(x, this.badge, R, cx, cy);
    }
    this.drawParticles(x, R, cx, cy);
  }

  private bodyPath(rx: number, ry: number, R: number): Path2D {
    const n = 72;
    const expN = 2.0 / 2.7;
    const tw = R * 1.0;
    const th = R * 0.94;
    const tr = R * 0.42;
    const p = new Path2D();
    const m = this.morph;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const px0 = rx * (ca >= 0 ? Math.pow(ca, expN) : -Math.pow(-ca, expN));
      const py0 = ry * (sa >= 0 ? Math.pow(sa, expN) : -Math.pow(-sa, expN));
      let px = px0;
      let py = py0;
      if (m >= 0.005) {
        const rr = rrPoint(ca, sa, tw, th, tr);
        px = lerp(px0, rr.x, m);
        py = lerp(py0, rr.y, m);
      }
      if (i === 0) p.moveTo(px, py);
      else p.lineTo(px, py);
    }
    p.closePath();
    return p;
  }

  private drawBody(x: CanvasRenderingContext2D, body: Path2D, R: number, rx: number, ry: number) {
    if (this.bodyColor) {
      // Mini bots: flat solid fill — no gradient, no reflection, no highlight
      x.fillStyle = rgba(this.bodyColor, 1);
      x.fill(body);
      return;
    }
    const g = x.createLinearGradient(rx * 0.7, -ry * 0.85, -rx * 0.8, ry * 0.9);
    g.addColorStop(0, rgba(BASE_TOP));
    g.addColorStop(1, rgba(BASE_BOTTOM));
    x.fillStyle = g;
    x.fill(body);

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

  private drawEyes(x: CanvasRenderingContext2D, body: Path2D, R: number, rx: number, ry: number) {
    let shape: EyeShape = this.eyeOverride ?? this.actEyeShape ?? this.cfg.eye;
    if (this.morph > 0.5) {
      if (this.isChewing) shape = "happy";
      else if (this.slotHTarget > 0.05 || this.slotH > 0.1) shape = "cup";
    }

    x.save();
    x.clip(body);
    const ink = this.isMini ? MINI_INK : INK;
    x.fillStyle = ink;
    x.strokeStyle = ink;

    for (const sd of [-1, 1]) {
      const eyeYaw = sd * EYE_SP + this.yaw + this.dYaw;
      let eyePitch = EYE_P + this.pitch + this.dPitch + this.roll;
      eyePitch = (((eyePitch + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      const cp = Math.cos(eyePitch);
      if (Math.cos(eyeYaw) * cp <= 0.04) continue;

      const ex = Math.sin(eyeYaw) * cp * rx;
      const ey = -Math.sin(eyePitch) * ry + (this.morph > 0 ? ry * 0.14 * this.morph : 0);
      const fx = lerp(Math.max(0.18, Math.cos(eyeYaw)), 1, this.morph * 0.7);
      const fy = lerp(Math.max(0.18, cp), 1, this.morph * 0.7);
      const eyeMult = this.isMini ? 1.9 : 1.0;
      const ew = R * EYE_W * this.es * eyeMult;
      const eh = R * EYE_H * this.es * eyeMult;

      x.save();
      x.translate(ex, ey);
      x.scale(fx, fy);
      this.drawEyeShape(x, shape, ew, eh, sd, ink);
      x.restore();
    }
    x.restore();
  }

  private drawEyeShape(
    x: CanvasRenderingContext2D, shape: EyeShape,
    w: number, h: number, sd: number, ink: string,
  ) {
    const t = now();
    switch (shape) {
      case "wide":
        this.drawEyeShape(x, "pill", w * 1.16, h * 1.12, sd, ink);
        break;
      case "pill": {
        const hh = Math.max(h * this.open, w * 0.3);
        roundRectPath(x, -w / 2, -hh / 2, w, hh, Math.min(w / 2, hh / 2));
        x.fill();
        break;
      }
      case "dot":
        x.beginPath();
        x.arc(0, 0, w * 0.45, 0, Math.PI * 2);
        x.fill();
        break;
      case "line":
        x.rotate(-sd * 0.2);
        roundRectPath(x, -w * 0.78, -w * 0.21, w * 1.56, w * 0.42, w * 0.21);
        x.fill();
        break;
      case "flat":
        roundRectPath(x, -w * 0.72, -w * 0.2, w * 1.44, w * 0.4, w * 0.2);
        x.fill();
        break;
      case "happy":
        x.lineWidth = w * 0.5;
        x.lineCap = "round";
        x.beginPath();
        x.arc(0, h * 0.18, w * 0.82, Math.PI * 1.12, Math.PI * 1.88);
        x.stroke();
        break;
      case "closed":
        x.lineWidth = w * 0.36;
        x.lineCap = "round";
        x.beginPath();
        x.arc(0, -h * 0.08, w * 0.78, Math.PI * 0.15, Math.PI * 0.85);
        x.stroke();
        break;
      case "spiral": {
        x.lineWidth = w * 0.22;
        x.lineCap = "round";
        x.beginPath();
        for (let a = 0; a < 4.4 * Math.PI; a += 0.2) {
          const r = w * 0.06 + a * w * 0.058;
          const aa = a + t * 9 * sd;
          const px = Math.cos(aa) * r;
          const py = Math.sin(aa) * r;
          if (a === 0) x.moveTo(px, py);
          else x.lineTo(px, py);
        }
        x.stroke();
        break;
      }
      case "heart":
        x.fillStyle = "#FF4D6D";
        heartPath(x, w * 1.2);
        x.fill();
        x.fillStyle = ink;
        break;
      case "star":
        x.fillStyle = "#F7B32B";
        x.rotate(t * 1.5 * sd);
        starPath(x, w * 1.05, w * 0.46);
        x.fill();
        x.fillStyle = ink;
        break;
      case "tired":
        roundRectPath(x, -w / 2, -h * 0.02, w, h * 0.38, w / 2);
        x.fill();
        roundRectPath(x, -w * 0.62, -h * 0.1, w * 1.24, w * 0.22, w * 0.11);
        x.fill();
        break;
      case "wink":
        if (sd < 0) {
          const hh = Math.max(h * this.open, w * 0.3);
          roundRectPath(x, -w / 2, -hh / 2, w, hh, Math.min(w / 2, hh / 2));
          x.fill();
        } else {
          x.lineWidth = w * 0.5;
          x.lineCap = "round";
          x.beginPath();
          x.arc(0, h * 0.18, w * 0.82, Math.PI * 1.12, Math.PI * 1.88);
          x.stroke();
        }
        break;
      case "cup": {
        // Flat top, rounded bottom corners (U shape) — used while the box is open
        const hh = Math.max(h * this.open, w * 0.3);
        const cr = Math.min(w / 2, hh / 2);
        x.beginPath();
        x.moveTo(-w / 2, -hh / 2);
        x.lineTo(w / 2, -hh / 2);
        x.lineTo(w / 2, hh / 2 - cr);
        x.quadraticCurveTo(w / 2, hh / 2, w / 2 - cr, hh / 2);
        x.lineTo(-w / 2 + cr, hh / 2);
        x.quadraticCurveTo(-w / 2, hh / 2, -w / 2, hh / 2 - cr);
        x.closePath();
        x.fill();
        break;
      }
    }
  }

  /** Mailbox slot: dark pill cut into the box face, with rim and lip highlights. */
  private drawMouth(x: CanvasRenderingContext2D, body: Path2D, R: number) {
    const m = this.morph;
    const hW = R * 1.8 * m;
    const hH = this.slotH * R * m;
    const hX = -hW / 2;
    const boxTop = -R * (0.88 + 0.06 * m);
    const hY = boxTop + R * 0.08 * m;

    x.save();
    x.clip(body);

    x.strokeStyle = `rgba(255,255,255,${0.55 * m})`;
    x.lineWidth = 1;
    x.lineCap = "round";
    x.beginPath();
    x.moveTo(-R * 0.9 * m, boxTop + 1);
    x.lineTo(R * 0.9 * m, boxTop + 1);
    x.stroke();

    if (hH > 0.8) {
      const hR = Math.min(hW / 2, hH / 2);
      const g = x.createLinearGradient(0, hY, 0, hY + hH);
      g.addColorStop(0, "rgb(7,8,10)");
      g.addColorStop(1, "rgb(16,19,26)");
      roundRectPath(x, hX, hY, hW, hH, hR);
      x.fillStyle = g;
      x.fill();
      if (hH > 4) {
        const lipR = Math.min(hR, (hW - 2) / 2);
        x.strokeStyle = `rgba(255,255,255,${0.28 * m})`;
        x.beginPath();
        x.moveTo(hX + lipR, hY + hH - 0.5);
        x.lineTo(hX + hW - lipR, hY + hH - 0.5);
        x.stroke();
      }
    }
    x.restore();
  }

  // ── Act props: all drawn in code, in body space so they follow the pose ──────

  private drawProps(x: CanvasRenderingContext2D, R: number, rx: number, ry: number, act: Act, alpha: number) {
    const p = this.props;
    x.save();
    x.globalAlpha = alpha;
    switch (act.name) {
      case "dance": this.drawHeadphones(x, R, rx, ry); break;
      case "mic": this.drawMicHeadset(x, R, rx, ry, act.variant === "muted"); break;
      case "mail": this.drawEnvelope(x, R, p.show, p.flap); break;
      case "catch": this.drawBox(x, R, ry, p.show, p.fall); break;
      case "check":
        this.drawHardHat(x, R, rx, ry, p.show);
        this.drawClipboard(x, R, rx, ry, p.show, p.stroke);
        break;
    }
    x.restore();
  }

  /** Headband over the head; returns the sideways shift that follows the head turn. */
  private drawHeadband(x: CanvasRenderingContext2D, R: number, rx: number, ry: number): number {
    const shift = Math.sin(this.yaw + this.dYaw) * rx * 0.1;
    const bandY = -ry * 0.08;
    const bandW = Math.max(1.2, R * 0.12);
    x.lineCap = "round";
    x.strokeStyle = GRAPHITE;
    x.lineWidth = bandW;
    x.beginPath();
    x.ellipse(shift * 0.5, bandY, rx * 0.98, ry * 1.12, 0, Math.PI * 1.04, Math.PI * 1.96);
    x.stroke();
    x.strokeStyle = "rgba(255,255,255,0.22)";
    x.lineWidth = bandW * 0.3;
    x.beginPath();
    x.ellipse(shift * 0.5, bandY, rx * 0.98, ry * 1.12, 0, Math.PI * 1.25, Math.PI * 1.6);
    x.stroke();
    return shift;
  }

  private drawEarCup(x: CanvasRenderingContext2D, R: number, cx: number, cy: number, scale = 1) {
    const w = R * 0.3 * scale;
    const h = R * 0.58 * scale;
    x.save();
    x.translate(cx, cy);
    const g = x.createLinearGradient(0, -h / 2, 0, h / 2);
    g.addColorStop(0, "rgb(84,89,103)");
    g.addColorStop(1, "rgb(36,39,47)");
    roundRectPath(x, -w / 2, -h / 2, w, h, w * 0.45);
    x.fillStyle = g;
    x.fill();
    x.strokeStyle = "rgba(255,255,255,0.18)";
    x.lineWidth = Math.max(0.8, R * 0.03);
    roundRectPath(x, -w * 0.32, -h * 0.36, w * 0.64, h * 0.72, w * 0.3);
    x.stroke();
    x.restore();
  }

  /** Music: headphones. */
  private drawHeadphones(x: CanvasRenderingContext2D, R: number, rx: number, ry: number) {
    const shift = this.drawHeadband(x, R, rx, ry);
    for (const sd of [-1, 1]) this.drawEarCup(x, R, sd * rx * 0.97 + shift, -ry * 0.04);
  }

  /** Audio: a call headset, boom mic to the mouth; sound waves, or a red muted mic. */
  private drawMicHeadset(x: CanvasRenderingContext2D, R: number, rx: number, ry: number, muted: boolean) {
    const shift = this.drawHeadband(x, R, rx, ry);
    this.drawEarCup(x, R, rx * 0.97 + shift, -ry * 0.04, 0.8);
    const lx = -rx * 0.97 + shift;
    const ly = -ry * 0.04;
    const mx = -rx * 0.32 + shift * 1.5;
    const my = ry * 0.52;
    x.lineCap = "round";
    x.strokeStyle = GRAPHITE;
    x.lineWidth = Math.max(1, R * 0.07);
    x.beginPath();
    x.moveTo(lx, ly + R * 0.1);
    x.quadraticCurveTo(lx + rx * 0.05, my + ry * 0.08, mx, my);
    x.stroke();
    this.drawEarCup(x, R, lx, ly);

    x.beginPath();
    x.ellipse(mx, my, R * 0.11, R * 0.085, 0, 0, Math.PI * 2);
    x.fillStyle = muted ? "rgb(244,80,94)" : "rgb(84,89,103)";
    x.fill();
    x.fillStyle = "rgba(255,255,255,0.3)";
    x.beginPath();
    x.ellipse(mx - R * 0.03, my - R * 0.03, R * 0.04, R * 0.025, 0, 0, Math.PI * 2);
    x.fill();

    if (muted) {
      x.strokeStyle = "#fff";
      x.lineWidth = Math.max(0.8, R * 0.03);
      x.beginPath();
      x.moveTo(mx - R * 0.07, my + R * 0.055);
      x.lineTo(mx + R * 0.07, my - R * 0.055);
      x.stroke();
      return;
    }
    const t = now();
    x.lineWidth = Math.max(1, R * 0.055);
    for (let i = 0; i < 3; i++) {
      const ph = (t * 1.4 + i / 3) % 1;
      x.strokeStyle = `rgba(255,255,255,${0.95 * (1 - ph)})`;
      x.beginPath();
      x.arc(mx, my, R * (0.2 + 0.32 * ph), Math.PI * 0.5, Math.PI * 1.1);
      x.stroke();
    }
  }

  /**
   * Messages: an envelope pops up, held low in front of the body; the flap
   * opens on a letter. Geometry in mochi/geometry.ts keeps it below the eyes.
   */
  private drawEnvelope(x: CanvasRenderingContext2D, R: number, show: number, flap: number) {
    if (show <= 0.01) return;
    const E = ENVELOPE;
    const w = R * E.w;
    const h = R * E.h;
    const parts = envelopeParts(flap);
    const apex = R * parts.apex;
    const edge = "rgba(0,0,0,0.18)";
    x.save();
    x.translate(0, R * E.cy);
    x.rotate(E.tilt);
    x.scale(show, show);
    x.lineWidth = 1;
    x.lineJoin = "round";
    const flapPath = () => {
      x.beginPath();
      x.moveTo(-w / 2, -h / 2);
      x.lineTo(w / 2, -h / 2);
      x.lineTo(0, apex);
      x.closePath();
    };
    if (parts.letterY !== null) {
      // Open: flap behind, the letter rising out of the pocket.
      flapPath();
      x.fillStyle = "rgb(232,228,218)";
      x.fill();
      x.strokeStyle = edge;
      x.stroke();
      const ly = R * parts.letterY;
      roundRectPath(x, (-w * E.letterW) / 2, ly, w * E.letterW, h * E.letterH, R * 0.04);
      x.fillStyle = "#fff";
      x.fill();
      x.stroke();
      x.strokeStyle = "rgba(0,0,0,0.25)";
      x.lineWidth = Math.max(0.6, R * 0.025);
      for (let i = 0; i < 2; i++) {
        x.beginPath();
        x.moveTo(-w * 0.26, ly + h * (0.14 + i * 0.14));
        x.lineTo(w * (0.2 - i * 0.12), ly + h * (0.14 + i * 0.14));
        x.stroke();
      }
      x.lineWidth = 1;
    }
    roundRectPath(x, -w / 2, -h / 2, w, h, R * 0.06);
    x.fillStyle = "rgb(252,250,244)";
    x.fill();
    x.strokeStyle = edge;
    x.stroke();
    x.strokeStyle = "rgba(0,0,0,0.12)";
    x.beginPath();
    x.moveTo(-w / 2, h / 2);
    x.lineTo(0, -h * 0.02);
    x.lineTo(w / 2, h / 2);
    x.stroke();
    if (parts.heartY !== null) {
      flapPath();
      x.fillStyle = "rgb(240,236,227)";
      x.fill();
      x.strokeStyle = edge;
      x.stroke();
      x.save();
      x.translate(0, R * parts.heartY);
      heartPath(x, R * E.heart);
      x.fillStyle = "#FF4D6D";
      x.fill();
      x.restore();
    }
    x.restore();
  }

  /** Shelf: a cardboard box on the head; a file sheet falls into it. */
  private drawBox(x: CanvasRenderingContext2D, R: number, ry: number, show: number, fall: number) {
    if (show <= 0.01) return;
    const w = R * 0.95;
    const h = R * 0.52;
    const baseY = -ry * 0.8; // sunk a little into the head
    const top = baseY - h;
    x.save();
    x.translate(0, baseY);
    x.scale(show, show);
    x.translate(0, -baseY);

    // The sheet goes behind the front face, so once in it only peeks out.
    const sw = R * 0.42;
    const sh = R * 0.54;
    const y = lerp(top - R * 2.4, top - sh * 0.12, fall * fall);
    x.save();
    x.translate(R * 0.04, y);
    x.rotate((1 - fall) * 0.5);
    roundRectPath(x, -sw / 2, -sh / 2, sw, sh, R * 0.03);
    x.fillStyle = "#fff";
    x.fill();
    x.strokeStyle = "rgba(0,0,0,0.18)";
    x.lineWidth = 1;
    x.stroke();
    x.fillStyle = "rgb(220,224,232)";
    x.beginPath();
    x.moveTo(sw / 2 - sw * 0.3, -sh / 2);
    x.lineTo(sw / 2, -sh / 2 + sw * 0.3);
    x.lineTo(sw / 2 - sw * 0.3, -sh / 2 + sw * 0.3);
    x.closePath();
    x.fill();
    x.strokeStyle = "rgba(0,0,0,0.22)";
    x.lineWidth = Math.max(0.6, R * 0.025);
    for (let i = 0; i < 3; i++) {
      x.beginPath();
      x.moveTo(-sw * 0.3, -sh * 0.12 + i * sh * 0.16);
      x.lineTo(sw * (0.3 - (i === 2 ? 0.2 : 0)), -sh * 0.12 + i * sh * 0.16);
      x.stroke();
    }
    x.restore();

    const g = x.createLinearGradient(0, top, 0, baseY);
    g.addColorStop(0, "rgb(214,163,104)");
    g.addColorStop(1, "rgb(176,128,76)");
    roundRectPath(x, -w / 2, top, w, h, R * 0.05);
    x.fillStyle = g;
    x.fill();
    x.fillStyle = "rgba(255,236,200,0.45)";
    x.fillRect(-w * 0.09, top, w * 0.18, h);
    x.fillStyle = "rgb(196,146,90)";
    for (const sd of [-1, 1]) {
      x.beginPath();
      x.moveTo(sd * w / 2, top);
      x.lineTo(sd * (w / 2 + w * 0.2), top - h * 0.38);
      x.lineTo(sd * w * 0.08, top - h * 0.3);
      x.lineTo(sd * w * 0.04, top);
      x.closePath();
      x.fill();
    }
    x.restore();
  }

  /** Space: a hard hat. */
  private drawHardHat(x: CanvasRenderingContext2D, R: number, rx: number, ry: number, show: number) {
    if (show <= 0.01) return;
    x.save();
    x.translate(0, -ry * 0.72);
    x.scale(show, show);
    const g = x.createLinearGradient(0, -ry * 0.62, 0, 0);
    g.addColorStop(0, "rgb(255,214,92)");
    g.addColorStop(1, "rgb(232,160,30)");
    x.beginPath();
    x.ellipse(0, 0, rx * 0.74, ry * 0.62, 0, Math.PI, Math.PI * 2);
    x.closePath();
    x.fillStyle = g;
    x.fill();
    x.fillStyle = "rgba(255,255,255,0.35)";
    roundRectPath(x, -R * 0.07, -ry * 0.6, R * 0.14, ry * 0.58, R * 0.07);
    x.fill();
    roundRectPath(x, -rx * 0.98, -R * 0.04, rx * 1.96, R * 0.12, R * 0.06);
    x.fillStyle = "rgb(226,150,24)";
    x.fill();
    x.restore();
  }

  /** Space: a clipboard at the side; the check mark draws itself. */
  private drawClipboard(
    x: CanvasRenderingContext2D, R: number, rx: number, ry: number, show: number, stroke: number,
  ) {
    if (show <= 0.01) return;
    const w = R * 0.62;
    const h = R * 0.8;
    x.save();
    x.translate(rx * 0.98, ry * 0.3);
    x.rotate(-0.16);
    x.scale(show, show);
    roundRectPath(x, -w / 2, -h / 2, w, h, R * 0.07);
    x.fillStyle = "rgb(176,125,76)";
    x.fill();
    roundRectPath(x, -w * 0.38, -h * 0.38, w * 0.76, h * 0.8, R * 0.03);
    x.fillStyle = "#fff";
    x.fill();
    roundRectPath(x, -w * 0.2, -h / 2 - R * 0.05, w * 0.4, R * 0.13, R * 0.04);
    x.fillStyle = "rgb(84,89,103)";
    x.fill();
    x.strokeStyle = "rgba(0,0,0,0.2)";
    x.lineWidth = Math.max(0.6, R * 0.025);
    x.beginPath();
    x.moveTo(-w * 0.26, -h * 0.22);
    x.lineTo(w * 0.26, -h * 0.22);
    x.stroke();
    if (stroke > 0) {
      const pts: [number, number][] = [[-0.2 * w, 0.08 * h], [-0.04 * w, 0.24 * h], [0.24 * w, -0.06 * h]];
      const seg = [Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1])];
      let left = stroke * (seg[0] + seg[1]);
      x.strokeStyle = "rgb(52,212,153)";
      x.lineWidth = R * 0.09;
      x.lineCap = "round";
      x.lineJoin = "round";
      x.beginPath();
      x.moveTo(pts[0][0], pts[0][1]);
      for (let i = 0; i < 2 && left > 0; i++) {
        const k = Math.min(1, left / seg[i]);
        x.lineTo(lerp(pts[i][0], pts[i + 1][0], k), lerp(pts[i][1], pts[i + 1][1], k));
        left -= seg[i];
      }
      x.stroke();
    }
    x.restore();
  }

  /** Hands sit behind the body — drawn before it, in world coordinates. */
  private drawHandsBehind(
    x: CanvasRenderingContext2D,
    R: number, rx: number, ry: number, cx: number, cy: number,
    tilt: number, sx: number, sy: number,
  ) {
    if (this.isMini) return;
    // Some acts bring the hands out too, independent of the greet's own tween.
    const amount = Math.max(this.hands, this.shown && ACT_HANDS.has(this.shown.name) ? this.actAmt : 0);
    if (amount <= 0.01) return;
    if (R <= 14) return; // meaningless at compact/peek sizes

    const n = now();
    const bodyH = 2 * ry;
    const hew = 0.3 * ry * amount;
    const heh = 0.26 * ry * amount;
    const hwB = rx * sx;
    const hhB = ry * sy;
    const isWaving = n >= this.waveStart && this.waveStart > 0 && n < this.waveUntil;

    for (const sd of [-1, 1]) {
      let localX: number;
      let localY: number;
      let handRot = 0;

      if (sd > 0 && isWaving) {
        const wt = n - this.waveStart;
        const rise = Math.min(1, wt / 0.18);
        const riseEased = 1 - Math.pow(1 - rise, 3);
        const restX = hwB * 1.08;
        const restY = hhB * 0.7;
        const oscX = Math.cos(13 * wt) * 0.06 * bodyH;
        const oscY = -Math.sin(13 * wt) * 0.14 * bodyH;
        const waveX = hwB * 1.1 + oscX;
        const waveY = -hhB * 0.15 + oscY;
        localX = restX + (waveX - restX) * riseEased;
        localY = restY + (waveY - restY) * riseEased;
        handRot = (-0.5 + Math.sin(13 * wt) * 0.35) * riseEased;
      } else if (sd < 0 && isWaving) {
        const wt = n - this.waveStart;
        localX = -hwB * 1.08;
        localY = hhB * 0.7 + Math.sin(6 * wt) * 0.04 * bodyH;
      } else {
        // Dance: hands take turns going up, opposite to the lean (0 when not dancing).
        const up = sd < 0 ? this.dHandL : this.dHandR;
        localX = sd * hwB * lerp(1.08, 1.18, up);
        localY = lerp(hhB * 0.7, -hhB * 0.3, up);
        handRot = -sd * 0.45 * up;
      }

      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);
      const worldX = cx + cosT * localX - sinT * localY;
      const worldY = cy + sinT * localX + cosT * localY;

      x.save();
      x.translate(worldX, worldY);
      if (handRot !== 0) x.rotate(handRot);
      const g = x.createLinearGradient(hew * 0.7, -heh * 0.85, -hew * 0.8, heh * 0.9);
      if (this.bodyColor) {
        g.addColorStop(0, rgba(mix3(this.bodyColor, [1, 1, 1], 0.35)));
        g.addColorStop(1, rgba(this.bodyColor));
      } else {
        g.addColorStop(0, rgba(BASE_TOP));
        g.addColorStop(1, rgba(BASE_BOTTOM));
      }
      x.beginPath();
      x.ellipse(0, 0, hew, heh, 0, 0, Math.PI * 2);
      x.fillStyle = g;
      x.fill();
      x.strokeStyle = "rgba(0,0,0,0.08)";
      x.lineWidth = 1;
      x.stroke();
      x.restore();
    }
  }

  private drawBadge(x: CanvasRenderingContext2D, badge: Badge, R: number, cx: number, cy: number) {
    const bs = this.badgeS * (this.isMini ? 1.25 : 1);
    const bx = cx - R * 0.72 * this.sx;
    const by = cy - R * 0.72 * this.sy;
    const t = now();

    x.save();
    x.translate(bx, by);
    x.scale(bs, bs);
    const col = rgba(badge.color);

    if (badge.kind === "dots") {
      if (this.isMini) {
        const phase = (t * 2.4) % 1;
        const dotR = R * 0.22 * (1 + 0.25 * Math.sin(phase * Math.PI * 2));
        x.fillStyle = "#000";
        x.beginPath();
        x.arc(0, 0, R * 0.2, 0, Math.PI * 2);
        x.fill();
        x.fillStyle = col;
        x.beginPath();
        x.arc(0, 0, dotR, 0, Math.PI * 2);
        x.fill();
      } else {
        const pw = R * 0.72;
        const ph = R * 0.36;
        roundRectPath(x, -pw / 2, -ph / 2, pw, ph, ph / 2);
        x.fillStyle = col;
        x.fill();
        for (let i = 0; i < 3; i++) {
          const phase = (((t * 2.4 - i * 0.22) % 1) + 1) % 1;
          const dotR = R * 0.055 * (1 + 0.4 * Math.max(0, Math.sin(phase * Math.PI * 2)));
          x.fillStyle = "#fff";
          x.beginPath();
          x.arc((i - 1) * R * 0.18, 0, dotR, 0, Math.PI * 2);
          x.fill();
        }
      }
    } else if (badge.kind === "bang" || badge.kind === "question") {
      x.fillStyle = "#000";
      x.beginPath();
      x.arc(0, 0, R * 0.3, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = col;
      x.beginPath();
      x.arc(0, 0, R * 0.23, 0, Math.PI * 2);
      x.fill();
      if (!this.isMini) {
        x.fillStyle = "#fff";
        x.font = `900 ${R * 0.32}px ${FONT}`;
        x.textAlign = "center";
        x.textBaseline = "middle";
        x.fillText(badge.kind === "bang" ? "!" : "?", 0, R * 0.02);
      }
    } else {
      x.fillStyle = "#000";
      x.beginPath();
      x.arc(0, 0, R * 0.2, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = col;
      x.beginPath();
      x.arc(0, 0, R * 0.135, 0, Math.PI * 2);
      x.fill();
    }
    x.restore();
  }

  private drawParticles(x: CanvasRenderingContext2D, R: number, cx: number, cy: number) {
    for (const p of this.particles) {
      if (p.age <= 0) continue;
      const k = p.age / p.life;
      const a = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
      const px = cx + (p.x + p.vx * p.age) * R * 1.3;
      const py = cy + (p.y + p.vy * p.age) * R * 1.3;
      const sz = R * p.size * (1 + k * 0.4);

      x.save();
      x.translate(px, py);
      x.globalAlpha = Math.min(1, Math.max(0, a));
      switch (p.type) {
        case "heart":
          x.rotate(Math.sin(p.age * 6) * 0.3);
          x.fillStyle = "#FF4D6D";
          heartPath(x, sz);
          x.fill();
          break;
        case "star":
          x.rotate(p.rot + p.age * 2);
          x.fillStyle = "#F7B32B";
          starPath(x, sz, sz * 0.45);
          x.fill();
          break;
        case "spark":
          x.rotate(p.rot);
          x.fillStyle = "#fff";
          starPath(x, sz * 0.8, sz * 0.18);
          x.fill();
          break;
        case "sweat":
          x.fillStyle = "#7CC7FF";
          x.beginPath();
          x.moveTo(0, -sz);
          x.quadraticCurveTo(sz * 0.8, sz * 0.2, 0, sz * 0.6);
          x.quadraticCurveTo(-sz * 0.8, sz * 0.2, 0, -sz);
          x.fill();
          break;
        case "note": {
          if (R <= 14) break; // just noise at compact size
          const s = sz * 1.15;
          x.rotate(Math.sin(p.age * 5) * 0.25);
          x.fillStyle = "rgba(255,255,255,0.92)";
          x.strokeStyle = "rgba(255,255,255,0.92)";
          x.beginPath();
          x.ellipse(-s * 0.22, s * 0.45, s * 0.3, s * 0.22, -0.4, 0, Math.PI * 2);
          x.fill();
          x.lineWidth = s * 0.13;
          x.lineCap = "round";
          x.beginPath();
          x.moveTo(s * 0.05, s * 0.42);
          x.lineTo(s * 0.05, -s * 0.6);
          x.quadraticCurveTo(s * 0.5, -s * 0.35, s * 0.42, s * 0.02);
          x.stroke();
          break;
        }
        case "z":
          x.fillStyle = "rgb(209,219,235)";
          x.font = `700 ${sz * 1.9}px ${FONT}`;
          x.textAlign = "center";
          x.textBaseline = "middle";
          x.fillText("z", 0, 0);
          break;
      }
      x.restore();
    }
  }
}

/** Ray → rounded-rect boundary intersection, for the mailbox morph. */
function rrPoint(ca: number, sa: number, W: number, H: number, cr: number): { x: number; y: number } {
  const eps = 1e-6;
  const kx = ca >= 0 ? 1 : -1;
  const ky = sa >= 0 ? 1 : -1;
  const cx = kx * (W - cr);
  const cy = ky * (H - cr);

  const dot = ca * cx + sa * cy;
  const disc = dot * dot - (cx * cx + cy * cy - cr * cr);
  if (disc >= 0) {
    const t = dot + Math.sqrt(disc);
    if (t > eps) {
      const px = ca * t;
      const py = sa * t;
      if (Math.abs(px) >= W - cr - eps && Math.abs(py) >= H - cr - eps) return { x: px, y: py };
    }
  }
  if (Math.abs(sa) > eps) {
    const t = (ky * H) / sa;
    if (t > eps) {
      const px = ca * t;
      if (Math.abs(px) <= W - cr + eps) return { x: px, y: ky * H };
    }
  }
  if (Math.abs(ca) > eps) {
    const t = (kx * W) / ca;
    if (t > eps) {
      const py = sa * t;
      if (Math.abs(py) <= H - cr + eps) return { x: kx * W, y: py };
    }
  }
  return { x: kx * W, y: ky * H };
}
