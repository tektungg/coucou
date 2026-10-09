// One integration pill's screen: show it next to Mochi (within the pill cap),
// its keys (Credential Manager), its plain preferences and its options.

import { Bridge } from "../core/bridge";
import { MAX_ACTIVE_PILLS, MESSAGE_APPS } from "../core/state";
import { h } from "../views/dom";
import { APP_LABELS, type IntegrationDef } from "./catalog";
import { canTurnOn, pillCapNote } from "./tiles";
import { DOT_MISSING, DOT_OK, DOT_WARN, hint, panel, row, statusDot, textInput, toggle, type SettingsCtx } from "./ui";

const STORED = "••••••••  (stored)";

/** The on/off switch, refused (with a note) once the cap is reached. */
function showRow(def: IntegrationDef, ctx: SettingsCtx, refresh: () => void): HTMLElement {
  const note = hint(pillCapNote(ctx.settings.activeIntegrations.length, MAX_ACTIVE_PILLS));
  const sw = toggle(ctx.settings.activeIntegrations.includes(def.id), (on) => {
    const active = ctx.settings.activeIntegrations;
    if (on && !canTurnOn(active, def.id, MAX_ACTIVE_PILLS)) {
      sw.classList.remove("on");
      sw.setAttribute("aria-pressed", "false");
      note.textContent = `${pillCapNote(active.length, MAX_ACTIVE_PILLS)}: turn one off first.`;
      return;
    }
    ctx.settings.activeIntegrations = on ? [...active, def.id] : active.filter((x) => x !== def.id);
    void ctx.save();
    refresh();
  });
  return row("Show next to Mochi", sw, note);
}

function keyFieldRow(field: IntegrationDef["fields"][number], ctx: SettingsCtx): HTMLElement {
  const stored = ctx.present[field.key] ?? false;
  const input = textInput({ type: field.secret ? "password" : "text", placeholder: stored ? STORED : field.placeholder });
  const dot = statusDot(stored);
  const save = h("button", { text: "Save" });
  save.addEventListener("click", async () => {
    const value = input.value.trim();
    try {
      await Bridge.secretSet(field.key, value);
      ctx.present[field.key] = value.length > 0;
      input.value = "";
      input.placeholder = value ? STORED : field.placeholder;
      dot.style.background = value ? DOT_OK : DOT_MISSING;
    } catch {
      dot.style.background = DOT_WARN; // Credential Manager refused; Rust logged why.
    }
  });
  return row(field.label, input, save, dot);
}

function prefRow(pref: NonNullable<IntegrationDef["prefs"]>[number], ctx: SettingsCtx): HTMLElement {
  const input = textInput({ placeholder: pref.placeholder, value: ctx.settings[pref.prop] });
  input.addEventListener("change", () => {
    ctx.settings[pref.prop] = input.value.trim();
    void ctx.save();
  });
  return row(pref.label, input);
}

function lyricsRow(ctx: SettingsCtx): HTMLElement {
  return row("Lyrics",
    toggle(ctx.settings.lyricsEnabled, (v) => { ctx.settings.lyricsEnabled = v; void ctx.save(); }),
    hint("From lrclib.net: the song's title and artist are sent there."));
}

function appsRow(ctx: SettingsCtx): HTMLElement {
  const boxes = MESSAGE_APPS.map((app) => {
    const box = h("input", { type: "checkbox" }) as HTMLInputElement;
    box.checked = ctx.settings.messageApps.includes(app);
    box.addEventListener("change", () => {
      const set = new Set(ctx.settings.messageApps);
      if (box.checked) set.add(app);
      else set.delete(app);
      ctx.settings.messageApps = MESSAGE_APPS.filter((a) => set.has(a));
      void ctx.save();
    });
    return h("label", { class: "check" }, box, h("span", { text: APP_LABELS[app] }));
  });
  return row("Apps", h("div", { class: "checks" }, ...boxes));
}

export function pillDetail(def: IntegrationDef, ctx: SettingsCtx, refresh: () => void): HTMLElement {
  return panel(null,
    def.info ? hint(def.info) : null,
    showRow(def, ctx, refresh),
    ...def.fields.map((f) => keyFieldRow(f, ctx)),
    ...(def.prefs ?? []).map((p) => prefRow(p, ctx)),
    def.lyrics ? lyricsRow(ctx) : null,
    def.apps ? appsRow(ctx) : null,
  );
}
