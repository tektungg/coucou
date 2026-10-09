// Dev harness: the Settings window (settings/main.ts) in a plain browser, with
// fake hooks, keys and CLI status, so the tile grid and every screen can be
// checked without Tauri. Not part of the app bundle. With `npm run dev`, open
// http://127.0.0.1:1420/dev/settings-preview.html
//   ?open=<tile name>   opens that tile (e.g. ?open=Claude%20Code)
//   ?nohooks            hooks not installed, relay missing
//   ?preview            Claude Code screen, on the diff step

import { DEFAULT_SETTINGS } from "../src/core/state";

const params = new URLSearchParams(location.search);
const hooksOn = !params.has("nohooks");

const FAKE: Record<string, unknown> = {
  boot: {
    settings: {
      ...DEFAULT_SETTINGS,
      activeIntegrations: ["integration_space", "integration_media", "integration_messages", "integration_shelf"],
      hooksInstalled: hooksOn,
    },
    version: "0.1.9", hookPath: "", cursorPoll: true,
    screen: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
  },
  hooks_status: {
    installed: hooksOn, hookReady: hooksOn,
    settingsPath: "C:\\Users\\you\\.claude\\settings.json",
    hookPath: "C:\\Users\\you\\AppData\\Local\\Coucou\\bin\\coucou-hook.exe",
  },
  claude_cli_status: { found: true, path: "C:\\Users\\you\\.local\\bin\\claude.exe" },
  hooks_preview: {
    diff: '  "hooks": {\n+   "PreToolUse": [{ "command": "coucou-hook.exe pre" }],\n-   "Stop": []\n  }',
    backup: "settings.json.2026-10-09.bak", fingerprint: "abc",
  },
};

// Bridge only talks to Rust when Tauri is there: fake it before the window loads.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (cmd: string, args?: { key?: string }) => {
    if (cmd === "secret_present") return args?.key === "anthropic-api-key";
    return FAKE[cmd] ?? null;
  },
};

await import("../src/settings/main");

/** Clicks the first element matching `selector` whose text includes `text`, once it exists. */
async function clickWhen(selector: string, text: string) {
  for (let i = 0; i < 50; i++) {
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.includes(text));
    if (el) return el.click();
    await new Promise((r) => setTimeout(r, 50));
  }
}

const open = params.has("preview") ? "Claude Code" : params.get("open");
if (open) await clickWhen(".tile", open);
if (params.has("preview")) await clickWhen("button", "hooks…");
