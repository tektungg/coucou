// Wardrobe view: port of WardrobeView (IslandViewContent.swift), from upstream
// (Louis-CFM/coucou c97dec1). Opened with a right-click on Mochi or from the
// tray menu. Resting the pointer on a button tries the outfit on Mochi; a click
// keeps it.

import { h } from "./dom";
import { State } from "../core/state";
import { drawWardrobeIcon } from "../mochi/outfits";
import {
  OUTFIT_LABELS, OUTFIT_SELECTIONS, WARDROBE_STRINGS, parseOutfit, resolveOutfit, seasonalOutfit,
  wardrobeHeader, type Outfit, type OutfitSelection,
} from "../mochi/wardrobe";
import type { ViewActions, ViewHost } from "./views";

const ICON = 28;

/** One outfit button and the canvas its icon is drawn on. */
interface Item {
  button: HTMLButtonElement;
  canvas: HTMLCanvasElement;
}

/** The wardrobe card: a button per outfit, a note naming the hovered or chosen one. */
class WardrobeView implements ViewHost {
  readonly el: HTMLElement;
  private readonly actions: ViewActions;
  private readonly note = h("span", { class: "wardrobe-note" });
  private readonly items = new Map<OutfitSelection, Item>();
  private hovered: OutfitSelection | null = null;
  private drawnSeason: Outfit | null = null;

  constructor(actions: ViewActions) {
    this.actions = actions;
    const grid = h("div", { class: "wardrobe-grid" });
    for (const sel of OUTFIT_SELECTIONS) grid.append(this.button(sel));
    const head = h("div", { class: "wardrobe-head" }, h("span", { class: "wardrobe-title", text: WARDROBE_STRINGS.title }), this.note);
    this.el = h("div", { class: "view wardrobe" }, h("div", { class: "card" }, h("div", { class: "stack wardrobe-stack" }, head, grid)));
  }

  sync() {
    this.drawIcons();
    // The island drops the preview when the view closes: so does the hover.
    if (State.wardrobePreview == null) this.hovered = null;
    const current = parseOutfit(State.settings.mochiOutfit);
    for (const [sel, { button }] of this.items) button.classList.toggle("on", sel === current);
    this.updateNote();
  }

  /** Resting on a button tries the outfit on; a click keeps it. */
  private button(sel: OutfitSelection): HTMLButtonElement {
    const canvas = h("canvas") as HTMLCanvasElement;
    const label = OUTFIT_LABELS[sel];
    const button = h("button", { class: "wardrobe-item", title: label, "aria-label": label }, canvas) as HTMLButtonElement;
    button.addEventListener("mouseenter", () => {
      this.hovered = sel;
      this.actions.previewOutfit(resolveOutfit(sel, new Date()));
      this.updateNote();
    });
    button.addEventListener("mouseleave", () => {
      if (this.hovered !== sel) return;
      this.hovered = null;
      this.actions.previewOutfit(null);
      this.updateNote();
    });
    button.addEventListener("click", () => this.actions.chooseOutfit(sel));
    this.items.set(sel, { button, canvas });
    return button;
  }

  private updateNote() {
    this.note.textContent = wardrobeHeader(this.hovered, parseOutfit(State.settings.mochiOutfit), new Date());
  }

  /** Icons are drawn once; only "auto" changes, with the season. */
  private drawIcons() {
    const season = seasonalOutfit(new Date());
    if (season === this.drawnSeason) return;
    const first = this.drawnSeason == null;
    this.drawnSeason = season;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const [sel, { canvas }] of this.items) {
      if (!first && sel !== "auto") continue;
      canvas.width = Math.round(ICON * dpr);
      canvas.height = Math.round(ICON * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawWardrobeIcon(ctx, ICON, sel, season, WARDROBE_STRINGS.autoBadge);
    }
  }
}

export function buildWardrobe(actions: ViewActions): ViewHost {
  return new WardrobeView(actions);
}
