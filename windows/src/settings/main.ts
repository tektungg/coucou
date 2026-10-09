// Settings window (Mochi Pop): a grid of tiles, one per thing you can set up;
// a tile opens its screen, with a way back. This is still the place where
// anything that writes to disk is confirmed (see claudeCode.ts).

import "./settings.css";
import { API_KEY_SECRET, Bridge, onEvent } from "../core/bridge";
import { DEFAULT_SETTINGS, HIDDEN_INTEGRATIONS, MAX_ACTIVE_PILLS, type Settings } from "../core/state";
import { h, clear, face, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { INTEGRATION_KEYS, visibleIntegrations } from "./catalog";
import { chatDetail } from "./chat";
import { claudeCodeDetail } from "./claudeCode";
import { generalDetail } from "./general";
import { pillDetail } from "./pills";
import { CHAT_TILE, CLAUDE_CODE_TILE, GENERAL_TILE, pillCapNote, settingsTiles, type Tile } from "./tiles";
import { chipEl, hint, type SettingsCtx } from "./ui";

const root = document.getElementById("settings-root")!;
/** Face sizes: tiles, a screen's header, the window's header. */
const TILE_FACE = 30;
const DETAIL_FACE = 34;
const HOME_FACE = 40;
const NO_HOOKS = { installed: false, settingsPath: "", hookPath: "", hookReady: false };

/** The tile open on screen, or null for the grid. */
let screen: string | null = null;

async function loadCtx(): Promise<SettingsCtx> {
  const boot = await Bridge.boot();
  const settings: Settings = { ...DEFAULT_SETTINGS, ...boot?.settings };
  const [hooks, hasKey, cli, stored] = await Promise.all([
    Bridge.hooksStatus(),
    Bridge.secretPresent(API_KEY_SECRET),
    Bridge.claudeCliStatus(),
    Promise.all(INTEGRATION_KEYS.map((k) => Bridge.secretPresent(k))),
  ]);
  const ctx: SettingsCtx = {
    settings, version: boot?.version ?? "", hooks: hooks ?? NO_HOOKS, hasKey: hasKey ?? false,
    cli: cli ?? { found: false, path: "" },
    present: Object.fromEntries(INTEGRATION_KEYS.map((k, i) => [k, stored[i] ?? false])),
    save: async () => void (await Bridge.saveSettings(ctx.settings)),
  };
  return ctx;
}

function tiles(ctx: SettingsCtx): Tile[] {
  return settingsTiles({
    settings: ctx.settings, hooks: ctx.hooks, hasKey: ctx.hasKey, cliFound: ctx.cli.found,
    pills: visibleIntegrations(HIDDEN_INTEGRATIONS),
  });
}

function tileEl(tile: Tile, open: (id: string) => void): HTMLElement {
  return h("button", { class: "tile", onclick: () => open(tile.id) },
    h("div", { class: "tile-top" }, face(tile.color, TILE_FACE), chipEl(tile.chip)),
    h("b", { text: tile.name }),
    h("span", { text: tile.status }));
}

function group(title: string, note: string | null, items: HTMLElement[]): HTMLElement {
  return h("section", { class: "group" },
    h("div", { class: "group-head" }, h("h2", { text: title }), note ? h("span", { class: "hint", text: note }) : null),
    h("div", { class: "tiles" }, ...items));
}

function gridScreen(ctx: SettingsCtx, open: (id: string) => void): HTMLElement[] {
  const all = tiles(ctx).map((t) => ({ t, el: tileEl(t, open) }));
  const pick = (ids: string[]) => all.filter(({ t }) => ids.includes(t.id)).map(({ el }) => el);
  const pillIds = visibleIntegrations(HIDDEN_INTEGRATIONS).map((d) => d.id);
  return [
    h("header", { class: "home-head" }, face("#ffffff", HOME_FACE),
      h("div", {}, h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: ctx.version })),
        hint("Pick a tile to set it up."))),
    group("Claude", null, pick([CLAUDE_CODE_TILE, CHAT_TILE])),
    group("Pills", `${pillCapNote(ctx.settings.activeIntegrations.length, MAX_ACTIVE_PILLS)}. Each Claude Code session also gets its own pill.`, pick(pillIds)),
    group("App", null, pick([GENERAL_TILE])),
    hint("No telemetry. Network requests only go to the services you configure yourself."),
  ];
}

function detailBody(id: string, ctx: SettingsCtx, refresh: () => void): HTMLElement {
  if (id === CLAUDE_CODE_TILE) return claudeCodeDetail(ctx, refresh);
  if (id === CHAT_TILE) return chatDetail(ctx);
  if (id === GENERAL_TILE) return generalDetail(ctx);
  const def = visibleIntegrations(HIDDEN_INTEGRATIONS).find((d) => d.id === id);
  return def ? pillDetail(def, ctx, refresh) : hint("Nothing to set up here.");
}

function detailScreen(id: string, ctx: SettingsCtx, back: () => void, refresh: () => void): HTMLElement[] {
  const tile = tiles(ctx).find((t) => t.id === id);
  return [
    h("button", { class: "back", onclick: back }, svg(ICONS.chevronLeft, 12, { stroke: 2.2 }), h("span", { text: "All settings" })),
    h("header", { class: "detail-head" }, face(tile?.color ?? "#ffffff", DETAIL_FACE),
      h("div", {}, h("h1", { text: tile?.name ?? "" }), hint(tile?.status ?? "")), chipEl(tile?.chip ?? null)),
    detailBody(id, ctx, refresh),
  ];
}

function render(ctx: SettingsCtx) {
  const open = (id: string) => { screen = id; render(ctx); window.scrollTo(0, 0); };
  const back = () => { screen = null; render(ctx); };
  clear(root);
  root.append(...(screen ? detailScreen(screen, ctx, back, () => render(ctx)) : gridScreen(ctx, open)));
}

async function main() {
  const ctx = await loadCtx();
  render(ctx);
  // The island writes settings too (the in-island sound and auto-close); keep in step.
  void onEvent<Settings>("settings-changed", (s) => {
    Object.assign(ctx.settings, s);
    if (!screen) render(ctx);
  });
}

void main();
