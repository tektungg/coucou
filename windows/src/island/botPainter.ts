// Draws the island's own Mochi on his canvas, with the glow behind him.
// Split out of island.ts, which owns where he is (springs) and passes it in.

import { State } from "../core/state";
import { botGlowColor, botGlowOpacity } from "../core/layout";
import { actFor, type MusicContext } from "../mochi/acts";
import { hexToRGB, type BotEngine } from "../mochi/engine";
import { h } from "../views/dom";
import { SeasonCache, parseOutfit } from "../mochi/wardrobe";

/** Extra canvas height above and below Mochi for his particles and props. */
export const BOT_OVERHANG = 40;
/** Extra canvas on each side, for the witch hat's brim and the Santa hat's tip. */
const BOT_SIDE = 24;
/** The glow spans this many times Mochi's diameter. */
const GLOW_SPAN = 2.2;
/** How far Mochi looks, by the pointer's distance from him (BotCanvasView.lookX / lookY). */
const LOOK_X_PX = 260;
const LOOK_Y_PX = 200;
/** Above this morph Mochi is a box, and the slot opens while a file is over him. */
const BOX_MORPH = 0.3;
const SLOT_OPEN = 0.2;
const SLOT_SNAP_MORPH = 0.05;

/** Where Mochi is drawn, in island coordinates, and how big. */
export interface BotPlacement {
  cx: number;
  cy: number;
  size: number;
}

export class BotPainter {
  readonly canvas = h("canvas", { id: "bot-canvas" }) as HTMLCanvasElement;
  readonly glow = h("div", { id: "bot-glow" });
  private readonly engine: BotEngine;
  private readonly seasons = new SeasonCache();
  private canvasPx = 0;

  constructor(engine: BotEngine) {
    this.engine = engine;
  }

  setVisible(visible: boolean) {
    this.canvas.style.opacity = visible ? "1" : "0";
  }

  /** The glow behind Mochi, `diameter` wide; null hides it. */
  placeGlow(at: { cx: number; cy: number; diameter: number } | null) {
    if (!at) {
      this.glow.style.display = "none";
      return;
    }
    const span = at.diameter * GLOW_SPAN;
    const style = this.glow.style;
    style.display = "block";
    style.width = `${span}px`;
    style.height = `${span}px`;
    style.left = `${at.cx - span / 2}px`;
    style.top = `${at.cy - span / 2}px`;
    style.background = `radial-gradient(circle, ${botGlowColor(State.effectiveState)} 0%, transparent 62%)`;
    style.opacity = String(botGlowOpacity(State.effectiveState));
  }

  /** Steps Mochi by `dt` and draws him at `at`, looking toward the pointer (`screenCx`: his x on screen). */
  draw(dt: number, at: BotPlacement, screenCx: number, music: MusicContext) {
    const w = Math.max(1, Math.round(at.size));
    const hCss = w + BOT_OVERHANG;
    const wCss = w + BOT_SIDE * 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.size(w, [wCss, hCss], dpr);
    this.canvas.style.left = `${at.cx - wCss / 2}px`;
    this.canvas.style.top = `${at.cy - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    this.dress(music, screenCx, at.cy);
    this.dressOutfit();
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, BOT_SIDE * dpr, 0);
    ctx.clearRect(-BOT_SIDE, 0, wCss, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  /** Sizes the canvas for a Mochi `w` wide, with room around him (`wCss` × `hCss`). */
  private size(w: number, [wCss, hCss]: [number, number], dpr: number) {
    if (this.canvasPx === w) return;
    this.canvasPx = w;
    this.canvas.width = Math.round(wCss * dpr);
    this.canvas.height = Math.round(hCss * dpr);
    this.canvas.style.width = `${wCss}px`;
    this.canvas.style.height = `${hCss}px`;
  }

  /**
   * The outfit (BotCanvasView.showOutfit, macOS): the main Mochi wears it, and so
   * does the compact island; a focused integration pill on the open island shows
   * its own colours instead, unless the wardrobe is open. There the hovered
   * outfit swaps in at once, without the drop-in.
   */
  private dressOutfit() {
    const inWardrobe = State.mode === "expanded" && State.view === "wardrobe";
    const shows = inWardrobe || State.mode !== "expanded" || !State.focusTask?.isIntegration;
    const outfit = State.wardrobePreview ?? this.seasons.get(parseOutfit(State.settings.mochiOutfit));
    this.engine.setOutfit(shows ? outfit : "none", !inWardrobe);
  }

  /** The focused pill's colour and act, where he looks, and the drop slot. */
  private dress(music: MusicContext, screenCx: number, cy: number) {
    const engine = this.engine;
    const focus = State.focusTask;
    engine.bodyColor = focus?.isIntegration ? hexToRGB(focus.color) : null;
    engine.act = actFor(focus, focus ? State.integrations[focus.id]?.data : null, performance.now(), music);
    engine.particleOverhang = BOT_OVERHANG;
    engine.lookX = Math.tanh((State.mouse.x - screenCx) / LOOK_X_PX);
    engine.lookY = -Math.tanh((State.mouse.y - cy) / LOOK_Y_PX);
    if (engine.morph > BOX_MORPH) {
      engine.slotHTarget = State.fileDragOver ? SLOT_OPEN : 0;
      return;
    }
    engine.slotHTarget = 0;
    if (engine.morph < SLOT_SNAP_MORPH) {
      engine.slotH = 0;
      engine.slotHVel = 0;
    }
  }
}
