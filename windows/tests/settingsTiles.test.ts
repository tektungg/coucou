// The Settings window's tile grid (settings/tiles.ts). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_TILE, CLAUDE_CODE_TILE, GENERAL_TILE, canTurnOn, pillCapNote, settingsTiles, type TileInput,
} from "../src/settings/tiles.ts";
import { INTEGRATIONS, visibleIntegrations } from "../src/settings/catalog.ts";

// state.ts cannot load under node --test (extensionless runtime imports); its
// MAX_ACTIVE_PILLS is 6.
const MAX_ACTIVE_PILLS = 6;

const input = (over: Partial<TileInput> = {}, settings: Partial<TileInput["settings"]> = {}): TileInput => ({
  settings: {
    activeIntegrations: ["integration_messages"], chatProvider: "api",
    soundEnabled: true, soundVolume: 0.1, autoCloseInterval: 15, ...settings,
  },
  hooks: { installed: true, hookReady: true },
  hasKey: true,
  cliFound: false,
  pills: [
    { id: "integration_messages", name: "Messages", color: "#5865F2", short: "Chat notifications" },
    { id: "integration_media", name: "Music", color: "#1DB954", short: "Now playing and lyrics" },
  ],
  ...over,
});
const tile = (i: TileInput, id: string) => settingsTiles(i).find((t) => t.id === id)!;

test("Claude Code, Chat, each pill, then General, in that order", () => {
  assert.deepEqual(settingsTiles(input()).map((t) => t.id),
    [CLAUDE_CODE_TILE, CHAT_TILE, "integration_messages", "integration_media", GENERAL_TILE]);
});

test("Claude Code tile follows the hooks", () => {
  assert.deepEqual(
    [tile(input(), CLAUDE_CODE_TILE).chip, tile(input(), CLAUDE_CODE_TILE).status], ["ON", "Hooks installed"]);
  const notYet = tile(input({ hooks: { installed: false, hookReady: true } }), CLAUDE_CODE_TILE);
  assert.deepEqual([notYet.chip, notYet.status], ["SETUP", "Hooks not installed"]);
  const noRelay = tile(input({ hooks: { installed: false, hookReady: false } }), CLAUDE_CODE_TILE);
  assert.deepEqual([noRelay.chip, noRelay.status], ["SETUP", "Relay missing"]);
});

test("Chat tile reads the chosen provider: API key or Claude Code login", () => {
  assert.equal(tile(input(), CHAT_TILE).chip, "ON");
  assert.equal(tile(input({ hasKey: false }), CHAT_TILE).status, "No API key yet");
  const cliMissing = tile(input({}, { chatProvider: "cli" }), CHAT_TILE);
  assert.deepEqual([cliMissing.chip, cliMissing.status], ["SETUP", "Claude Code not found"]);
  const cli = tile(input({ cliFound: true, hasKey: false }, { chatProvider: "cli" }), CHAT_TILE);
  assert.deepEqual([cli.chip, cli.status], ["ON", "Claude Code login"], "the CLI needs no key");
});

test("pill tiles are ON when shown next to Mochi, OFF otherwise", () => {
  const i = input();
  assert.equal(tile(i, "integration_messages").chip, "ON");
  assert.equal(tile(i, "integration_media").chip, "OFF");
  assert.equal(tile(i, "integration_media").status, "Now playing and lyrics");
});

test("General tile sums up sound and auto-close", () => {
  assert.equal(tile(input(), GENERAL_TILE).status, "Sound 50% · closes after 15s");
  assert.equal(tile(input({}, { soundEnabled: false, autoCloseInterval: 30 }), GENERAL_TILE).status,
    "Sound off · closes after 30s");
  assert.equal(tile(input(), GENERAL_TILE).chip, null);
});

test("the pill cap: a new pill only while under it, turning off always works", () => {
  const full = ["a", "b", "c", "d", "e", "f"];
  assert.equal(canTurnOn(full, "g", MAX_ACTIVE_PILLS), false);
  assert.equal(canTurnOn(full, "a", MAX_ACTIVE_PILLS), true, "already on");
  assert.equal(canTurnOn(full.slice(1), "g", MAX_ACTIVE_PILLS), true);
  assert.equal(pillCapNote(4, MAX_ACTIVE_PILLS), "4/6 pills in use");
});

test("Settings offers only the integrations this build shows, each with a tile line", () => {
  const hidden = new Set(["integration_stripe", "integration_github"]);
  const visible = visibleIntegrations(hidden);
  assert.ok(visible.every((d) => !hidden.has(d.id)));
  assert.equal(visible.length + hidden.size, INTEGRATIONS.length);
  assert.ok(INTEGRATIONS.every((d) => d.short.length > 0 && d.short.length <= 28), "fits one tile line");
});
