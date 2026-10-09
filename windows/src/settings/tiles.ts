// The Settings window's top screen (Mochi Pop): a grid of tiles, one per thing
// you can set up, each with a mini Mochi, a one-line status and a chip. Pure, so
// tests/settingsTiles.test.ts covers every state.

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
  settings: Pick<Settings, "activeIntegrations" | "chatProvider" | "soundEnabled" | "soundVolume" | "autoCloseInterval">;
  hooks: { installed: boolean; hookReady: boolean };
  hasKey: boolean;
  cliFound: boolean;
  pills: { id: string; name: string; color: string; short: string }[];
}

export const CLAUDE_CODE_TILE = "claude-code";
export const CHAT_TILE = "chat";
export const GENERAL_TILE = "general";
/** The sound slider's top (the island plays its WAVs at most this loud). */
export const SOUND_VOLUME_MAX = 0.2;

const CLAUDE_ORANGE = "#E07B53";
const CHAT_BLUE = "#8FD3FF";
const GENERAL_WHITE = "#FFFFFF";

function claudeCodeTile(hooks: TileInput["hooks"]): Tile {
  const base = { id: CLAUDE_CODE_TILE, name: "Claude Code", color: CLAUDE_ORANGE };
  if (hooks.installed) return { ...base, status: "Hooks installed", chip: "ON" };
  return { ...base, status: hooks.hookReady ? "Hooks not installed" : "Relay missing", chip: "SETUP" };
}

function chatTile(input: TileInput): Tile {
  const base = { id: CHAT_TILE, name: "Chat", color: CHAT_BLUE };
  if (input.settings.chatProvider === "cli") {
    return input.cliFound
      ? { ...base, status: "Claude Code login", chip: "ON" }
      : { ...base, status: "Claude Code not found", chip: "SETUP" };
  }
  return input.hasKey
    ? { ...base, status: "API key saved", chip: "ON" }
    : { ...base, status: "No API key yet", chip: "SETUP" };
}

function generalTile(settings: TileInput["settings"]): Tile {
  const pct = Math.round((settings.soundVolume / SOUND_VOLUME_MAX) * 100);
  const sound = settings.soundEnabled ? `Sound ${pct}%` : "Sound off";
  return {
    id: GENERAL_TILE, name: "General", color: GENERAL_WHITE,
    status: `${sound} · closes after ${Math.round(settings.autoCloseInterval)}s`, chip: null,
  };
}

/** Claude first (what Coucou is for), then one tile per pill, then General. */
export function settingsTiles(input: TileInput): Tile[] {
  const active = new Set(input.settings.activeIntegrations);
  const pills = input.pills.map((p): Tile => ({
    id: p.id, name: p.name, color: p.color, status: p.short, chip: active.has(p.id) ? "ON" : "OFF",
  }));
  return [claudeCodeTile(input.hooks), chatTile(input), ...pills, generalTile(input.settings)];
}

/** "4/6 pills in use", under the pill tiles. */
export function pillCapNote(used: number, max: number): string {
  return `${used}/${max} pills in use`;
}

/** Whether turning `id` on stays within the cap (turning one off always does). */
export function canTurnOn(active: readonly string[], id: string, max: number): boolean {
  return active.includes(id) || active.length < max;
}
