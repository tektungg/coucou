// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { blockPageZoom, fitZoom, watchPixelRatio } from "./core/zoom";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { Recap } from "./recap/recap";

/** Pause has to reach Rust too, or the pollers keep calling out. */
function setPaused(on: boolean) {
  if (State.paused === on) return;
  State.paused = on;
  void Bridge.setPaused(on);
}

/** The tray menu: Open, Weekly recap, Wardrobe, Settings, Pause / Resume. */
async function registerTrayHandler(island: Island) {
  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "wardrobe":
        setPaused(false);
        island.alert("wardrobe");
        break;
      case "recap":
        setPaused(false);
        void Recap.open(island);
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });
}

/** Display, pixel ratio and preference changes. */
async function registerWindowEvents(island: Island) {
  await onEvent<null>("screen-changed", async () => {
    await fitZoom();
    void Bridge.reposition();
  });
  watchPixelRatio(() => void fitZoom());

  // Settings → Reload sounds: read the sounds folder again, and let them hear it.
  await onEvent<null>("sounds-changed", () => {
    void Sound.reload().then(() => Sound.play("pop"));
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  // Before the island: its canvases size their bitmaps from the pixel ratio
  // once, so the zoom correction has to land first.
  await fitZoom();
  blockPageZoom();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  await registerTrayHandler(island);
  await registerWindowEvents(island);

  registerHookHandlers(island);
  registerIntegrationHandlers(island);

  // Monday recap: app start (greeting over), an agent starting work, waking up.
  const checkRecap = () => void Recap.check(island);
  island.onGreetingDone = checkRecap;
  island.onWake = checkRecap;
  await onEvent<null>("recap-check", checkRecap);

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
