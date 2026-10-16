// The Settings window's top screen (Mochi Pop): a grid of tiles, one per thing
// you can set up, each with a mini Mochi, a one-line status and a chip. Pure, so
// tests/settingsTiles.test.ts covers every state.

import { providerDef } from "../core/providers";
import { activeKeys } from "../core/shortcuts";
import type { Settings } from "../core/state";

export type TileChip = "ON" | "SETUP" | "OFF";

export interface Tile {
  /** "claude-code", "chat", "general", or an integration pill ID. */
  id: string;
  name: string;
  color: string;
  status: string;
  chip: TileChip | null;
}

export interface TileInput {
  settings: Pick<
    Settings,
    | "activeIntegrations" | "chatProvider" | "soundEnabled" | "soundVolume" | "autoCloseInterval" | "shortcuts"
    | "ollamaUrl" | "lmstudioUrl" | "customUrl"
  >;
  hooks: { installed: boolean; hookReady: boolean };
  /** The Anthropic key is saved. */
  hasKey: boolean;
  /** The other chat providers' keys saved, by credential store name. */
  keys?: Record<string, boolean>;
  cliFound: boolean;
  pills: { id: string; name: string; color: string; short: string }[];
}

export const CLAUDE_CODE_TILE = "claude-code";
export const CHAT_TILE = "chat";
export const GENERAL_TILE = "general";
export const SHORTCUTS_TILE = "shortcuts";
/** The sound slider's top (the island plays its WAVs at most this loud). */
export const SOUND_VOLUME_MAX = 0.2;

const CLAUDE_ORANGE = "#E07B53";
const CHAT_BLUE = "#8FD3FF";
const GENERAL_WHITE = "#FFFFFF";
const SHORTCUTS_LILAC = "#C9B6FF";

function claudeCodeTile(hooks: TileInput["hooks"]): Tile {
  const base = { id: CLAUDE_CODE_TILE, name: "Claude Code", color: CLAUDE_ORANGE };
  if (hooks.installed) return { ...base, status: "Hooks installed", chip: "ON" };
  return { ...base, status: hooks.hookReady ? "Hooks not installed" : "Relay missing", chip: "SETUP" };
}

function chatTile(input: TileInput): Tile {
  const base = { id: CHAT_TILE, name: "Chat", color: CHAT_BLUE };
  const p = providerDef(input.settings.chatProvider);
  if (p.id === "claude-cli") {
    return input.cliFound
      ? { ...base, status: "Claude Code login", chip: "ON" }
      : { ...base, status: "Claude Code not found", chip: "SETUP" };
  }
  if (p.urlField) {
    return input.settings[p.urlField]
      ? { ...base, status: `${p.name} connected`, chip: "ON" }
      : { ...base, status: `${p.name} not connected`, chip: "SETUP" };
  }
  // Anthropic keeps its own wording; the others name themselves.
  const saved = p.id === "anthropic" ? input.hasKey : input.keys?.[p.key ?? ""] === true;
  const who = p.id === "anthropic" ? "API" : p.name;
  return saved
    ? { ...base, status: `${who} key saved`, chip: "ON" }
    : { ...base, status: `No ${who} key yet`, chip: "SETUP" };
}

function generalTile(settings: TileInput["settings"]): Tile {
  const pct = Math.round((settings.soundVolume / SOUND_VOLUME_MAX) * 100);
  const sound = settings.soundEnabled ? `Sound ${pct}%` : "Sound off";
  return {
    id: GENERAL_TILE, name: "General", color: GENERAL_WHITE,
    status: `${sound} · closes after ${Math.round(settings.autoCloseInterval)}s`, chip: null,
  };
}

function shortcutsTile(settings: TileInput["settings"]): Tile {
  const n = activeKeys(settings.shortcuts).length;
  const status = n === 0 ? "All off" : `${n} on, from any app`;
  return { id: SHORTCUTS_TILE, name: "Shortcuts", color: SHORTCUTS_LILAC, status, chip: null };
}

/** Claude first (what Coucou is for), then one tile per pill, then General and Shortcuts. */
export function settingsTiles(input: TileInput): Tile[] {
  const active = new Set(input.settings.activeIntegrations);
  const pills = input.pills.map((p): Tile => ({
    id: p.id, name: p.name, color: p.color, status: p.short, chip: active.has(p.id) ? "ON" : "OFF",
  }));
  return [claudeCodeTile(input.hooks), chatTile(input), ...pills, generalTile(input.settings), shortcutsTile(input.settings)];
}

/** "4/6 pills in use", under the pill tiles. */
export function pillCapNote(used: number, max: number): string {
  return `${used}/${max} pills in use`;
}

/** Whether turning `id` on stays within the cap (turning one off always does). */
export function canTurnOn(active: readonly string[], id: string, max: number): boolean {
  return active.includes(id) || active.length < max;
}
