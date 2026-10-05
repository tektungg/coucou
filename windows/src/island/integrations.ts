// Integration events → island state. Port of the `handle…` methods in the Swift
// pollers: a genuinely new item flips the pill to finished/error, badges it when
// the pill isn't focused, plays a sound, and clears itself after 60 s.

import { onEvent, Bridge, type IntegrationUpdate } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

/** Which Credential Manager key backs each pill. */
const KEY_FOR: Record<string, string> = {
  integration_stripe: "stripe-api-key",
  integration_github: "github-token",
  integration_vercel: "vercel-token",
  integration_n8n: "n8n-api-key",
  integration_resend: "resend-api-key",
  integration_notion: "notion-api-key",
  integration_calcom: "calcom-api-key",
};

const clearTimers = new Map<string, number>();

export function registerIntegrationHandlers(island: Island) {
  void onEvent<IntegrationUpdate>("integration", (update) => handle(island, update));
  void refreshConfigured();
}

/** Asks Rust which keys exist so the idle cards can say so. */
export async function refreshConfigured() {
  for (const [id, key] of Object.entries(KEY_FOR)) {
    const present = (await Bridge.secretPresent(key)) ?? false;
    const info = State.integrations[id] ?? { data: {}, error: null, loaded: false, configured: false };
    State.integrations[id] = { ...info, configured: present };
  }
  const hooks = State.settings.hooksInstalled;
  const claude = State.integrations.integration_claude ?? {
    data: {}, error: null, loaded: false, configured: false,
  };
  State.integrations.integration_claude = { ...claude, configured: hooks };
  State.notify();
}

function handle(island: Island, update: IntegrationUpdate) {
  if (State.paused) return;

  const previous = State.integrations[update.id];
  State.integrations[update.id] = {
    data: update.error ? (previous?.data ?? {}) : update.data,
    error: update.error,
    loaded: update.error ? (previous?.loaded ?? false) : true,
    configured: previous?.configured ?? true,
  };

  if (!update.error) applyPersonal(update);

  const event = update.event;
  if (event) {
    const task = State.tasks.find((t) => t.id === update.id);
    if (task) {
      task.state = event.success ? "finished" : "error";
      task.steps = event.detail ? [event.label, event.detail] : [event.label];
      task.stepIndex = task.steps.length - 1;
      if (State.focusId !== update.id) {
        task.pillBadge = event.success ? "finished" : "error";
      }
      Sound.play(event.success ? "finish" : "error");
      // Same as the Swift pollers: show the compact island so the badge is seen,
      // but never steal the screen for a successful deploy. A chat message is
      // the exception: it is meant to be read, so the island opens on it.
      if (update.id === "integration_messages" && event.success) island.showMessage(update.id);
      else island.reveal();

      const existing = clearTimers.get(update.id);
      if (existing != null) window.clearTimeout(existing);
      clearTimers.set(
        update.id,
        window.setTimeout(() => {
          clearTimers.delete(update.id);
          const t = State.tasks.find((x) => x.id === update.id);
          if (!t || (t.state !== "finished" && t.state !== "error")) return;
          t.state = "idle";
          t.steps = [];
          t.stepIndex = 0;
          t.pillBadge = null;
          // Back to whatever the pill's data says (music playing, quota high).
          applyPersonal({ id: update.id, data: State.integrations[update.id]?.data ?? {}, error: null, event: null });
          State.notify();
        }, 60_000),
      );
    }
  }

  State.notify();
}

/**
 * What the personal pills' data means for the island beyond their cards:
 * each session pill gets its context and cost, and a pill's mood follows its
 * data (sweating near the 5-hour limit, bobbing while music plays).
 */
function applyPersonal(update: IntegrationUpdate) {
  const data = (update.data ?? {}) as Record<string, unknown>;
  const task = State.tasks.find((t) => t.id === update.id);
  // An event card (a new message, a quota warning) owns the pill until it clears.
  const showingEvent = task != null && (task.state === "finished" || task.state === "error");

  if (update.id === "integration_quota") {
    const sessions = Array.isArray(data.sessions) ? (data.sessions as Record<string, unknown>[]) : [];
    for (const s of sessions) {
      const pill = State.tasks.find((t) => t.sessionId && t.sessionId === s.sessionId);
      if (!pill) continue;
      if (typeof s.ctxPct === "number") pill.ctxPct = s.ctxPct;
      if (typeof s.costUsd === "number") pill.costUsd = s.costUsd;
    }
    const five = (data.fiveHour as { pct?: unknown } | null)?.pct;
    if (task && !showingEvent) task.state = typeof five === "number" && five >= 90 ? "ratelimit" : "idle";
  } else if (update.id === "integration_media") {
    if (task && !showingEvent) task.state = data.playing === true ? "working" : "idle";
  }
}
