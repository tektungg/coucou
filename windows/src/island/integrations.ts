// Integration events → island state. Port of the `handle…` methods in the Swift
// pollers: a genuinely new item flips the pill to finished/error, badges it when
// the pill isn't focused, plays a sound, and clears itself after 60 s.

import { alertTarget } from "./quotaAlert";
import { detectAct } from "../mochi/acts";
import { patchAudioCard } from "../views/personal";
import { onEvent, Bridge, type IntegrationUpdate } from "../core/bridge";
import { gitHubAlert, type GitHubEvent } from "../core/github";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

const GITHUB = "integration_github";

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

/** How long a pill's event card (a deploy, a message) stays before its data shows again. */
const EVENT_CARD_MS = 60_000;
const clearTimers = new Map<string, number>();

export function registerIntegrationHandlers(island: Island) {
  void onEvent<IntegrationUpdate>("integration", (update) => handle(island, update));
  void onEvent<GitHubEvent[]>("github-alerts", handleGitHubAlerts);
  void refreshConfigured();
  State.subscribe(refreshGitHubWhenShown);
}

/**
 * AppState.handleGitHubEvents: the loudest event sets the badge (only while the
 * GitHub pill isn't the one on screen) and plays its sound. Unlike the other
 * integrations it leaves Mochi's state alone, and the badge stays until the
 * pill is focused, as on macOS. Ported from upstream 0f4edf1.
 */
export function handleGitHubAlerts(events: GitHubEvent[]) {
  if (State.paused) return;
  const alert = gitHubAlert(events);
  if (!alert) return;
  const task = State.tasks.find((t) => t.id === GITHUB);
  if (!task) return;
  if (State.focusId !== GITHUB) task.pillBadge = alert.badge;
  Sound.play(alert.sound);
  State.notify();
}

let gitHubShown = false;

/** The GitHub card just came on screen (focused, island opened): refresh it if stale. */
function refreshGitHubWhenShown() {
  const shown = State.mode === "expanded" && State.focusTask?.id === GITHUB;
  if (shown && !gitHubShown) void Bridge.githubRefresh("pulse");
  gitHubShown = shown;
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

  if (!update.error) {
    applyPersonal(update);
    startAct(update, previous?.loaded ? previous.data : null);
  }
  if (update.id === "integration_audio") patchAudioCard();
  if (update.event) showEvent(island, update.id, update.event);

  State.notify();
}

/** Mochi's act for this pill's news (a new message, file, Space item done). */
function startAct(update: IntegrationUpdate, previousData: Record<string, unknown> | null) {
  const act = detectAct(update.id, previousData, update.data, update.event);
  const actTask = act ? State.tasks.find((t) => t.id === update.id) : null;
  if (act && actTask) actTask.act = { ...act, at: performance.now() };
}

type IntegrationEvent = NonNullable<IntegrationUpdate["event"]>;

/** A pill's event (a deploy, a message, a usage alert): its card, its badge, its sound. */
function showEvent(island: Island, id: string, event: IntegrationEvent) {
  // Claude usage alerts still reach a session pill when its own pill is off.
  const targetId = alertTarget(id, State.tasks);
  const task = targetId ? State.tasks.find((t) => t.id === targetId) : null;
  if (!targetId || !task) return;
  task.state = event.success ? "finished" : "error";
  task.steps = event.detail ? [event.label, event.detail] : [event.label];
  task.stepIndex = task.steps.length - 1;
  if (State.focusId !== targetId) task.pillBadge = event.success ? "finished" : "error";
  Sound.play(event.success ? "finish" : "error");
  // Out on the desktop he looks up at it from his spot.
  island.desktop.notice();
  // Same as the Swift pollers: show the compact island so the badge is seen,
  // but never steal the screen for a successful deploy. A chat message is
  // the exception: it is meant to be read, so the island opens on it.
  if (id === "integration_messages" && event.success) void island.showMessage(id);
  else island.reveal();
  scheduleEventClear(targetId);
}

/** A minute later the event card gives the pill back to its data. */
function scheduleEventClear(targetId: string) {
  const existing = clearTimers.get(targetId);
  if (existing != null) window.clearTimeout(existing);
  clearTimers.set(
    targetId,
    window.setTimeout(() => {
      clearTimers.delete(targetId);
      const t = State.tasks.find((x) => x.id === targetId);
      if (!t || (t.state !== "finished" && t.state !== "error")) return;
      t.state = "idle";
      t.steps = [];
      t.stepIndex = 0;
      t.pillBadge = null;
      t.act = null;
      // Back to whatever the pill's data says (music playing, quota high).
      applyPersonal({ id: targetId, data: State.integrations[targetId]?.data ?? {}, error: null, event: null });
      State.notify();
    }, EVENT_CARD_MS),
  );
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
