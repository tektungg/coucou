// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";
import { parseQuestions } from "./askQuestion";
import { isSessionPill, resolvesCard, routeHook } from "./sessions";

const CLAUDE_ID = "integration_claude";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
  /** "ask_user_question" when the relay's --ask hook waits for answers. */
  coucou_kind?: string;
}

/** Clears the question card if no answer was given before the hook gave up. */
let questionTimeout: number | null = null;

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = "VS Code";
  t.pillBadge = null;
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  // The relay hung up: the terminal answered first and Claude Code aborted it.
  void onEvent<{ request_id: string }>("hook-gone", ({ request_id }) =>
    dismissCard(island, (card) => card.requestId === request_id),
  );
}

/**
 * Takes down an approval, plan or question card that was answered elsewhere
 * (in the terminal), without sending any decision. `matches` picks the card.
 */
function dismissCard(
  island: Island,
  matches: (card: { requestId: string; taskId: string }) => boolean,
) {
  const card = State.pendingApproval ?? State.pendingQuestion;
  if (!card || !matches(card)) return;
  if (State.pendingApproval) {
    if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
    pendingTimeout = null;
  } else if (questionTimeout != null) {
    window.clearTimeout(questionTimeout);
    questionTimeout = null;
  }
  State.pendingApproval = null;
  State.pendingQuestion = null;
  State.isPinned = false;
  island.dropPin();
  State.updateTask(card.taskId, "working");
  State.setPillBadge(card.taskId, null);
  if (State.view === "approval" || State.view === "plan" || State.view === "question") {
    island.setView(State.defaultView());
  }
  State.notify();
}


function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved. Claude Code events get one pill per session; only a
  // payload without a session id falls back to the catch-all Claude Code pill.
  const validAgent = validateAgent(payload.coucou_agent);
  const sessionId = payload.session_id ?? "";
  const agentId = routeHook(validAgent, sessionId);
  const isExternalAgent = validAgent !== null;
  const isSession = isSessionPill(agentId);

  const focused = State.focusTask?.id === agentId;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /** Ensure the pill exists and is up to date (name, cwd, activity). */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, validAgent!, agentColor(validAgent!));
    } else if (isSession) {
      State.upsertSession(agentId, sessionId, projectName, cwd);
    } else {
      upsert(projectName, cwd);
    }
  };
  // Every Claude Code event keeps its session pill alive and in order, except
  // the end of the session itself.
  if (isSession && name !== "SessionEnd") ensurePill();
  State.sweepSessions();

  // Backstop for the terminal answering first when the relay's hang-up was
  // missed: the session carrying on means its card is no longer waiting.
  const cardTool = State.pendingApproval?.tool ?? (State.pendingQuestion ? "AskUserQuestion" : "");
  if (cardTool && resolvesCard(name, payload.tool_name, cardTool)) {
    dismissCard(island, (card) => card.taskId === agentId);
  }

  switch (name) {
    case "SessionStart":
      ensurePill();
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      State.updateTask(agentId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      if (payload.coucou_kind === "ask_user_question") {
        showQuestion(island, payload, isExternalAgent, agentId, ensurePill);
        break;
      }
      ensurePill();
      const tool = payload.tool_name ?? "Tool";
      // The waiting --ask copy of this event owns AskUserQuestion's card; the
      // plain one only marks the task, without a step that says nothing.
      if (tool === "AskUserQuestion") {
        State.updateTask(agentId, "question");
        break;
      }
      State.updateTask(agentId, "working");
      State.appendStep(agentId, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      State.updateTask(agentId, "working");
      break;

    case "PostToolUseFailure":
      State.updateTask(agentId, "working");
      State.appendStep(agentId, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
      }
      break;
    }

    case "Stop":
      State.updateTask(agentId, "finished");
      if (payload.message) State.appendStep(agentId, payload.message.slice(0, 60));
      Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(agentId, "finished");
      window.setTimeout(() => {
        if (isExternalAgent) {
          State.removeTask(agentId);
        } else {
          State.updateTask(agentId, "idle");
          State.setPillBadge(agentId, null);
        }
      }, 5200);
      break;

    case "StopFailure":
      State.updateTask(agentId, "error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;

    case "SessionEnd":
      if (isExternalAgent) {
        State.removeTask(agentId);
      } else if (isSession) {
        // A moment to see it end; a session resumed meanwhile keeps its pill.
        State.updateTask(agentId, "idle");
        const endedAt = performance.now();
        window.setTimeout(() => {
          const t = State.tasks.find((x) => x.id === agentId);
          if (t && (t.lastEventAt ?? 0) <= endedAt) State.removeTask(agentId);
        }, 5000);
      } else {
        State.updateTask(agentId, "idle");
        clearSession();
      }
      break;

    case "SubagentStart":
      State.appendStep(agentId, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(agentId, "• subagent done");
      break;

    case "PermissionRequest": {
      // External agents do not get an approval card — showing one would look like
      // a Claude Code request. Decline immediately so the agent re-asks in its
      // terminal. Approval support for other agents will come with Codex support.
      if (isExternalAgent) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      const tool = payload.tool_name ?? "Tool";
      // AskUserQuestion: the terminal shows its dialog at the same moment, and
      // the card answers it too (the relay hands the answers back as
      // updatedInput). Whichever is answered first wins; the other goes away.
      if (tool === "AskUserQuestion") {
        showQuestion(island, payload, isExternalAgent, agentId, ensurePill);
        break;
      }
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (
        (State.pendingApproval && State.pendingApproval.requestId !== requestId) ||
        State.pendingQuestion
      ) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      ensurePill();
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const input = payload.tool_input ?? {};
      const isPlan = tool === "ExitPlanMode";
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        taskId: agentId,
        tool,
        command: approvalTarget(tool, input),
        kind: isPlan ? "plan" : "tool",
        plan: isPlan && typeof input.plan === "string" ? input.plan : undefined,
        planFilePath:
          isPlan && typeof input.planFilePath === "string" ? input.planFilePath : undefined,
      };
      const cardView = isPlan ? "plan" : "approval";
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(agentId, "approval");
      State.isPinned = true;
      Sound.play("approval");
      // The session that asks takes the focus: with one pill per session, a
      // badge on a pill would leave the card naming the wrong project.
      State.setFocus(agentId);
      island.alert(cardView);
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        State.updateTask(agentId, "working");
        State.setPillBadge(agentId, null);
        if (State.view === "approval" || State.view === "plan") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}

/**
 * AskUserQuestion through the relay's --ask hook: the questions with their
 * options, answered from the island. Anything the card cannot carry goes
 * straight back to the terminal.
 */
function showQuestion(
  island: Island,
  payload: HookPayload,
  isExternalAgent: boolean,
  taskId: string,
  ensurePill: () => void,
) {
  const requestId = payload.request_id ?? "";
  const items = parseQuestions(payload.tool_input);
  const busy =
    State.pendingApproval != null ||
    (State.pendingQuestion != null && State.pendingQuestion.requestId !== requestId);
  if (isExternalAgent || !items || busy) {
    if (requestId) void Bridge.approvalDecline(requestId);
    return;
  }
  ensurePill();
  if (questionTimeout != null) window.clearTimeout(questionTimeout);
  State.pendingQuestion = { requestId, taskId, items, index: 0, answers: [] };
  // Same 800 ms ack window as a permission request.
  if (requestId) void Bridge.approvalAck(requestId);
  State.updateTask(taskId, "question");
  State.isPinned = true;
  Sound.play("question");
  // As with approvals: the session asking takes the focus.
  State.setFocus(taskId);
  island.alert("question");
  // The relay stops waiting at 110 s; past that the terminal is asking.
  questionTimeout = window.setTimeout(() => {
    questionTimeout = null;
    if (State.pendingQuestion?.requestId !== requestId) return;
    State.pendingQuestion = null;
    State.isPinned = false;
    island.dropPin();
    State.updateTask(taskId, "working");
    State.setPillBadge(taskId, null);
    if (State.view === "question") island.setView(State.defaultView());
    State.notify();
  }, 110_000);
}
