// General screen: sound, auto-close, which display the island lives on, and
// launching at startup.

import { Bridge, type DisplayChoice } from "../core/bridge";
import { h } from "../views/dom";
import { SOUND_VOLUME_MAX } from "./tiles";
import { hint, panel, row, select, toggle, type SettingsCtx } from "./ui";

/** Auto-close bounds, in seconds, and the value an empty field falls back to. */
const AUTO_CLOSE_MIN = 5;
const AUTO_CLOSE_MAX = 120;
const AUTO_CLOSE_DEFAULT = 15;
const SCREENS: [string, string][] = [["primary", "Main display"], ["cursor", "Display under the cursor"]];

function soundRow(ctx: SettingsCtx): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: String(SOUND_VOLUME_MAX), step: "0.005", value: String(ctx.settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    ctx.settings.soundVolume = Number(volume.value);
    void ctx.save();
  });
  return row("Sound", toggle(ctx.settings.soundEnabled, (v) => { ctx.settings.soundEnabled = v; void ctx.save(); }), volume);
}

function autoCloseRow(ctx: SettingsCtx): HTMLElement {
  const field = h("input", {
    class: "num", type: "number", min: String(AUTO_CLOSE_MIN), max: String(AUTO_CLOSE_MAX), step: "1",
    value: String(Math.round(ctx.settings.autoCloseInterval)),
  }) as HTMLInputElement;
  field.addEventListener("change", () => {
    const secs = Number(field.value) || AUTO_CLOSE_DEFAULT;
    ctx.settings.autoCloseInterval = Math.max(AUTO_CLOSE_MIN, Math.min(AUTO_CLOSE_MAX, secs));
    field.value = String(ctx.settings.autoCloseInterval);
    void ctx.save();
  });
  return row("Auto-close", field, hint("seconds after you leave the island"));
}

/**
 * The "Island lives on" choices: main display, display under the cursor, then
 * each connected display. A saved display that is gone shows as the main one,
 * which is where Rust puts the island too (island.rs target_monitor).
 */
export function screenOptions(displays: DisplayChoice[], current: string): { options: [string, string][]; value: string } {
  const options: [string, string][] = [...SCREENS, ...displays.map((d): [string, string] => [d.key, d.label])];
  const value = options.some(([key]) => key === current) ? current : "primary";
  return { options, value };
}

function screenSelect(ctx: SettingsCtx): HTMLSelectElement {
  const el = select(SCREENS, ctx.settings.screen, (v) => {
    ctx.settings.screen = v;
    void ctx.save();
  });
  void Bridge.listMonitors().then((displays) => {
    const { options, value } = screenOptions(displays ?? [], ctx.settings.screen);
    el.replaceChildren(...options.map(([key, label]) => h("option", { value: key, text: label })));
    el.value = value;
  });
  return el;
}

export function generalDetail(ctx: SettingsCtx): HTMLElement {
  return panel(null,
    soundRow(ctx),
    autoCloseRow(ctx),
    row("Island lives on", screenSelect(ctx)),
    row("Launch at startup", toggle(ctx.settings.autostart, (v) => { ctx.settings.autostart = v; void ctx.save(); })),
  );
}
