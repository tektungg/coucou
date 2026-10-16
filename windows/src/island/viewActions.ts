// What the island's views can ask for (Deny / Allow, the plan and question
// answers, the sound controls…). Split out of island.ts; the island hands it
// what it needs (ViewActionHost).

import { Bridge } from "../core/bridge";
import type { IslandViewName } from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { ViewActions } from "../views/views";
import type { IslandStateMachine } from "./fsm";

/** The ↗ button's targets, as openAgentTarget() on macOS. */
const TARGET_URLS: Record<string, string> = {
  integration_resend: "https://resend.com/emails",
  integration_vercel: "https://vercel.com/dashboard",
  integration_github: "https://github.com/pulls",
  integration_stripe: "https://dashboard.stripe.com/payments",
  integration_notion: "https://notion.so",
  integration_calcom: "https://app.cal.com/bookings",
};

export interface ViewActionHost {
  readonly fsm: IslandStateMachine;
  setView(view: IslandViewName): void;
  collapse(): void;
  /** A card that held Claude Code (approval, plan, question) has been answered. */
  finishCard(): void;
  /** The choose card's "Keep on shelf". */
  keepDropOnShelf(): void;
}

/** "Open terminal": the focused session's own window, else its folder in VS Code. */
function openTerminal() {
  const task = State.focusTask;
  void Bridge.openSession(task?.sessionId ?? null, task?.sessionCwd ?? null);
}

/** The ↗ button: opens whatever the focused pill points at. */
function openTarget() {
  const task = State.focusTask;
  if (!task) return;
  if (task.id === "integration_claude" || task.sessionId) openTerminal();
  else if (task.id === "integration_n8n") void Bridge.openN8n();
  else if (TARGET_URLS[task.id]) void Bridge.openUrl(TARGET_URLS[task.id]);
}

/** Saves the preferences the island itself changed, and redraws. */
function saveSettings() {
  void Bridge.saveSettings(State.settings);
  State.notify();
}

/** Deny / Allow, the plan's choices and the question's answers, back to the relay. */
function decisionActions(host: ViewActionHost): Pick<ViewActions, "decide" | "decidePlan" | "answerQuestion"> {
  return {
    decide: (d) => {
      const req = State.pendingApproval;
      void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
      if (!req) return;
      Sound.play(d === "deny" ? "blip" : "approve");
      void Bridge.approvalDecision(req.requestId, d);
      host.finishCard();
    },
    // The plan card: approve into a mode, or send it back with a note. The
    // relay turns either line into Claude Code's JSON (coucou-hook).
    decidePlan: (choice) => {
      const req = State.pendingApproval;
      void Bridge.log(`plan ${"mode" in choice ? choice.mode : "feedback"} req=${req?.requestId ?? "none"}`);
      if (!req) return;
      const line = "mode" in choice ? { plan: choice.mode } : { feedback: choice.feedback };
      Sound.play("mode" in choice ? "approve" : "blip");
      void Bridge.approvalDecision(req.requestId, JSON.stringify(line));
      host.finishCard();
    },
    // The question card: answers go back through the hook; null hands the
    // question to the terminal instead.
    answerQuestion: (answers) => {
      const q = State.pendingQuestion;
      void Bridge.log(`answer ${answers ? "sent" : "terminal"} req=${q?.requestId ?? "none"}`);
      if (!q) return;
      Sound.play(answers ? "approve" : "blip");
      if (answers) void Bridge.approvalDecision(q.requestId, JSON.stringify({ answers }));
      else void Bridge.approvalDecline(q.requestId);
      host.finishCard();
    },
  };
}

/** The sound and auto-close controls on the island's own settings view. */
function settingsActions(host: ViewActionHost): Pick<ViewActions, "toggleSound" | "setVolume" | "setAutoClose"> {
  return {
    toggleSound: () => {
      State.settings.soundEnabled = !State.settings.soundEnabled;
      Sound.setEnabled(State.settings.soundEnabled);
      saveSettings();
    },
    setVolume: (v) => {
      State.settings.soundVolume = v;
      Sound.setVolume(v);
      saveSettings();
    },
    setAutoClose: (s) => {
      State.settings.autoCloseInterval = s;
      host.fsm.homeToPetitDelay = s;
      saveSettings();
    },
  };
}

export function buildViewActions(host: ViewActionHost): ViewActions {
  return {
    setView: (v) => host.setView(v),
    collapse: () => host.collapse(),
    setFocus: (id) => {
      State.setFocus(id);
      Sound.play("blip");
    },
    openTerminal,
    openTarget,
    openUrl: (url) => {
      if (url) void Bridge.openUrl(url);
    },
    ...decisionActions(host),
    // Only the island's own text fields need keystrokes; everything else
    // leaves the focus where the user was typing.
    wantKeyboard: (on) => void Bridge.focusWindow(on),
    keepOnShelf: () => host.keepDropOnShelf(),
    ...settingsActions(host),
    openSettingsWindow: () => void Bridge.openSettingsWindow(),
    blip: () => Sound.play("blip"),
  };
}
