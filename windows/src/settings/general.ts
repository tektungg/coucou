// General screen: sound, auto-close, which display the island lives on,
// launching at startup, the plan pills in the island's header and the weekly
// recap's history.

import { Bridge, type DisplayChoice } from "../core/bridge";
import { SOUND_NAMES } from "../core/sound";
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

/** How long Rust's "sounds-changed" round trip takes before the count is read again. */
const RECOUNT_DELAY_MS = 300;

/** Your own sounds: open the folder, reload it, and how many sounds it replaces. */
function customSoundsRows(): HTMLElement[] {
  const count = hint("");
  const recount = () =>
    void Bridge.customSounds(SOUND_NAMES).then((own) => {
      const n = own?.length ?? 0;
      count.textContent = n > 0 ? `${n} custom` : "";
    });
  recount();
  const folder = h("button", { text: "Open sounds folder", onclick: () => void Bridge.revealSoundsFolder() });
  const reload = h("button", {
    text: "Reload sounds",
    onclick: () => void Bridge.reloadSounds().then(() => window.setTimeout(recount, RECOUNT_DELAY_MS)),
  });
  return [
    row("Your sounds", folder, reload, count),
    hint("Put a file named like one of Mochi's sounds (finish.wav, approval.mp3, greet.m4a…) in the sounds folder to replace it, then Reload."),
  ];
}

function openOnHoverRows(ctx: SettingsCtx): HTMLElement[] {
  return [
    row("Open on hover", toggle(ctx.settings.openOnHover, (v) => { ctx.settings.openOnHover = v; void ctx.save(); })),
    hint("On: the island opens when the pointer reaches it and closes when it leaves. Off: hovering shows the compact island, a click opens it."),
  ];
}

type PlanSetting = "showPlanInNotch" | "showCodexPlanInNotch";

/** The plan pills in the open island's header (views/plan.ts), both off by default. */
function planRows(ctx: SettingsCtx): HTMLElement[] {
  const sw = (key: PlanSetting) => toggle(ctx.settings[key], (v) => {
    ctx.settings[key] = v;
    void ctx.save();
  });
  return [
    // The label column is narrow: the rest of the name reads after the switch, as Weekly recap does.
    row("Claude plan", sw("showPlanInNotch"), hint("in the island header")),
    hint("Shows your Claude plan usage (5-hour and weekly limits) as a pill in the island's header; a click opens the details. The numbers are the ones the Claude pill reads from the Claude Code status line files. They come from the Claude Code command-line tool only: the Claude desktop app does not run the status line, so the pill shows no number if you only use the desktop app. Pro and Max plans only."),
    row("Codex plan", sw("showCodexPlanInNotch"), hint("in the island header")),
    hint("Shows your Codex plan usage (5-hour and weekly limits, free resets left). Coucou asks the Codex CLI (codex app-server) when the pill shows, at most once a minute and never while paused; nothing is installed. Codex must be signed in with ChatGPT."),
  ];
}

/** How long "History cleared." stays before the button can be used again. */
const CLEARED_MS = 2400;

/** Weekly recap: keep the history or not, and clear it. The prefs live with it in Rust. */
function recapRows(): HTMLElement[] {
  const feedback = hint("");
  const sw = toggle(true, (v) => void Bridge.recapSetEnabled(v));
  void Bridge.recapPrefs().then((prefs) => {
    if (prefs) sw.classList.toggle("on", prefs.enabled);
  });
  const clearBtn = h("button", {
    class: "danger",
    text: "Clear history",
    onclick: async () => {
      clearBtn.disabled = true;
      await Bridge.recapClear();
      feedback.textContent = "History cleared.";
      window.setTimeout(() => {
        clearBtn.disabled = false;
        feedback.textContent = "";
      }, CLEARED_MS);
    },
  }) as HTMLButtonElement;
  return [
    row("Weekly recap", sw, hint("Keep a history of my coding sessions"), clearBtn, feedback),
    hint("Counts and project names only, never commands, files or prompts. Kept on this computer for 12 weeks; the recap opens on Mondays from 8 am, or from the tray."),
  ];
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
    ...customSoundsRows(),
    ...openOnHoverRows(ctx),
    autoCloseRow(ctx),
    row("Island lives on", screenSelect(ctx)),
    row("Launch at startup", toggle(ctx.settings.autostart, (v) => { ctx.settings.autostart = v; void ctx.save(); })),
    ...planRows(ctx),
    ...recapRows(),
  );
}
