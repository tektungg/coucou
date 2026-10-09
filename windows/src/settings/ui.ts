// Building blocks of the Settings window (Mochi Pop): rows, panels, switches,
// notices and the shared state every screen reads and writes.

import { h } from "../views/dom";
import type { HookStatus } from "../core/bridge";
import type { Settings } from "../core/state";
import type { TileChip } from "./tiles";

export const DOT_OK = "#22c55e";
export const DOT_MISSING = "#f4505e";
export const DOT_WARN = "#f5a524";

/** What the screens share: the settings being edited and what was found on this PC. */
export interface SettingsCtx {
  settings: Settings;
  version: string;
  hooks: HookStatus;
  /** The chat's API key is in the Credential Manager. */
  hasKey: boolean;
  cli: { found: boolean; path: string };
  /** Which integration keys are stored, by Credential Manager key. */
  present: Record<string, boolean>;
  save(): Promise<void>;
}

export function toggle(on: boolean, onChange: (v: boolean) => void): HTMLButtonElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    el.setAttribute("aria-pressed", String(next));
    onChange(next);
  });
  return el;
}

export function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? DOT_OK : DOT_MISSING}` });
}

export function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

/** A labelled row: the label column, then its controls. */
export function row(label: string | null, ...children: (Node | null)[]): HTMLElement {
  return h("div", { class: "row" }, label ? h("label", { text: label }) : null, ...children);
}

/** A soft card holding a group of rows, with an optional title. */
export function panel(title: string | null, ...children: (Node | null)[]): HTMLElement {
  return h("section", { class: "panel" }, title ? h("h2", { text: title }) : null, ...children);
}

export function notice(kind: "ok" | "err" | "warn", text: string): HTMLElement {
  return h("div", { class: `notice ${kind}`, text });
}

export function hint(text: string): HTMLElement {
  return h("div", { class: "hint", text });
}

/** A text or password field that takes the rest of its row. */
export function textInput(opts: { type?: "text" | "password"; placeholder: string; value?: string }): HTMLInputElement {
  const el = h("input", {
    class: "grow-input", type: opts.type ?? "text", placeholder: opts.placeholder,
    autocomplete: "off", spellcheck: "false",
  }) as HTMLInputElement;
  if (opts.value !== undefined) el.value = opts.value;
  return el;
}

export function select(options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const el = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of options) el.append(h("option", { value: id, text: label }));
  if (!options.some(([id]) => id === value)) el.append(h("option", { value, text: value }));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

/** ON / SETUP / OFF, as on the tiles. */
export function chipEl(chip: TileChip | null): HTMLElement | null {
  return chip ? h("span", { class: `chip ${chip.toLowerCase()}`, text: chip }) : null;
}
