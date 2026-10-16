// The chat's provider and model picker (ModelPickerView in IslandViewContent.swift),
// from upstream Louis-CFM/coucou (741aab2), where it lived in chat.ts: provider
// chips, then the chosen provider's models, asked for only once it is picked.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type ModelInfo } from "../core/bridge";
import { activeModel, pickModel, providerDef, visibleProviders, withModel, type ProviderDef } from "../core/providers";
import { Sound } from "../core/sound";
import { State } from "../core/state";

export const PICKER_TEXT = {
  loading: "Loading models…",
  noKey: "No API key yet: add it in Settings → Chat.",
  openSettings: "Open Settings",
};

const errorText = (err: unknown) => String(err).replace(/^Error:\s*/, "");

function saveSettings() {
  void Bridge.saveSettings(State.settings);
}

export class ChatPicker {
  readonly el: HTMLElement;
  private readonly chips = h("div", { class: "picker-chips" });
  private readonly list = h("div", { class: "picker-list" });
  /** Models already asked for, by provider; a model server is asked again each time. */
  private readonly cache = new Map<string, ModelInfo[]>();
  private open = false;
  /** Bumped on every new request, so a slow answer for another provider is dropped. */
  private request = 0;
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
    this.el = h("div", { class: "picker" }, this.chips, h("div", { class: "picker-rule" }), this.list);
  }

  get isOpen(): boolean {
    return this.open;
  }

  show() {
    this.open = true;
    this.el.classList.add("on");
    this.drawChips();
    this.onChange();
    void this.loadModels();
  }

  hide() {
    this.open = false;
    this.request++;
    this.el.classList.remove("on");
    this.onChange();
  }

  private drawChips() {
    clear(this.chips);
    for (const p of visibleProviders(State.settings)) this.chips.append(this.chip(p));
  }

  private chip(p: ProviderDef): HTMLElement {
    const on = p.id === State.settings.chatProvider;
    const chip = h(
      "button",
      { class: on ? "picker-chip on" : "picker-chip", style: `--accent:${p.accent}` },
      h("i", { class: "picker-dot" }),
      h("span", { text: p.name }),
    );
    chip.addEventListener("click", () => {
      if (p.id === State.settings.chatProvider) return;
      State.settings = { ...State.settings, chatProvider: p.id };
      saveSettings();
      Sound.play("pop");
      this.drawChips();
      void this.loadModels();
      this.onChange();
    });
    return chip;
  }

  private status(text: string, withSettings = false) {
    const line = h("div", { class: "picker-status", text });
    if (withSettings) {
      line.append(h("button", {
        class: "picker-link", text: PICKER_TEXT.openSettings, onclick: () => void Bridge.openSettingsWindow(),
      }));
    }
    this.list.replaceChildren(line);
  }

  private drawModels(p: ProviderDef, models: ModelInfo[]) {
    clear(this.list);
    const current = activeModel(State.settings);
    for (const m of models) this.list.append(this.modelRow(p, m, m.id === current));
    this.list.querySelector(".picker-model.on")?.scrollIntoView({ block: "nearest" });
  }

  private modelRow(p: ProviderDef, m: ModelInfo, on: boolean): HTMLElement {
    const row = h(
      "button",
      { class: on ? "picker-model on" : "picker-model", style: `--accent:${p.accent}`, title: m.id },
      h("span", { class: "picker-model-name", text: m.label }),
      on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
    );
    row.addEventListener("click", () => {
      State.settings = withModel(State.settings, p.id, m.id);
      saveSettings();
      Sound.play("blip");
      this.hide();
    });
    return row;
  }

  private async loadModels() {
    const p = providerDef(State.settings.chatProvider);
    const ticket = ++this.request;
    const cached = p.urlField ? undefined : this.cache.get(p.id);
    if (cached) {
      this.drawModels(p, cached);
      return;
    }
    // Nothing is asked of a provider that has no key yet.
    if (p.key && !(await Bridge.secretPresent(p.key))) {
      if (ticket === this.request) this.status(PICKER_TEXT.noKey, true);
      return;
    }
    if (ticket !== this.request) return;
    this.status(PICKER_TEXT.loading);
    try {
      const models = await Bridge.chatModels(p.id);
      if (ticket === this.request) this.modelsArrived(p, models);
    } catch (err) {
      if (ticket === this.request) this.status(errorText(err), Boolean(p.key));
    }
  }

  /** The list is in: keep the saved model if offered, else pick a sensible one. */
  private modelsArrived(p: ProviderDef, models: ModelInfo[]) {
    if (!p.urlField) this.cache.set(p.id, models);
    const keep = pickModel(p, models.map((m) => m.id), activeModel(State.settings));
    if (keep && keep !== activeModel(State.settings)) {
      State.settings = withModel(State.settings, p.id, keep);
      saveSettings();
      this.onChange();
    }
    this.drawModels(p, models);
  }
}
