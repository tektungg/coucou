// Dev harness: the real island (island/island.ts), opened on one view with fake
// sessions, pills and cards, so the Mochi Pop look can be checked in a plain
// browser without Claude Code, Spotify or a phone. Not part of the app bundle.
// With `npm run dev`, open http://127.0.0.1:1420/dev/pop-preview.html
//   ?view=overview|prompt|approval|question|settings|plan|finished|error|empty
//   &focus=<pill id>   (overview only; default: the session pill)
// Mochi still animates; screenshots are taken after it has settled.

import type { AskItem } from "../src/island/askQuestion";
import { VIEW_LAYOUTS, type IslandViewName } from "../src/core/layout";

const params = new URLSearchParams(location.search);
const asked = params.get("view") ?? "overview";
const view: IslandViewName = asked in VIEW_LAYOUTS ? (asked as IslandViewName) : "overview";

// Bridge only talks to Rust when Tauri is there: fake it before the app loads.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async () => null,
};

const { State } = await import("../src/core/state");
await import("../src/style.css");
const { Island } = await import("../src/island/island");

const now = Date.now();
State.settings = {
  ...State.settings,
  soundEnabled: true,
  hooksInstalled: true,
  activeIntegrations: ["integration_space", "integration_media", "integration_messages", "integration_shelf", "integration_audio"],
};
State.loadIntegrationTasks();
State.upsertSession("cc_preview", "preview-session", "coucou", "D:/Personal Project/coucou");
State.updateTask("cc_preview", "working");
State.appendStep("cc_preview", "Editing engine.ts");
State.upsertSession("cc_api", "api-session", "venturo-api", "D:/Work/api");
State.setPillBadge("integration_messages", null);

const ok = (data: Record<string, unknown>) => ({ loaded: true, configured: true, error: null, data });
State.integrations.integration_messages = ok({
  messages: [
    { id: 1, app: "telegram", sender: "ダーリン", text: "You have a new message", at: now - 20_000 },
    { id: 2, app: "telegram", sender: "Dev Squad", text: "Deploy jam 3 ya", place: "Dev Squad", at: now - 300_000 },
    { id: 3, app: "whatsapp", sender: "Mama", text: "Nanti pulang jam berapa?", at: now - 120_000 },
  ],
});
State.integrations.integration_space = ok({
  date: "2026-10-09", totalPoint: 8, totalDone: 3, warnings: [],
  items: [
    { name: "Mochi Pop header", point: 3, done: false, kind: "sprint", status: "open" },
    { name: "Envelope off the eyes", point: 2, done: true, kind: "sprint", status: "done" },
    { name: "Settings tile grid", point: 3, done: false, kind: "timebox", status: "open" },
  ],
});
State.integrations.integration_media = ok({
  app: "Spotify", title: "Placeholder Song", artist: "Some Artist", album: "Preview",
  playing: false, durationMs: 215_000, positionMs: 64_000, positionAtMs: now,
  canPrev: true, canNext: true, canPlayPause: true,
});

const ASK: AskItem[] = [{
  header: "Look", question: "Which accent should the primary buttons use?", multiSelect: false,
  options: [
    { label: "Pink", description: "Mochi Pop default" },
    { label: "Blue", description: "Matches the user bubble" },
    { label: "White", description: "The current look" },
  ],
}];

switch (view) {
  case "approval":
    State.pendingApproval = {
      requestId: "r1", sessionId: "preview-session", tool: "Bash", command: "rm -rf dist && npm run build",
      taskId: "cc_preview", kind: "tool",
    };
    State.updateTask("cc_preview", "approval");
    break;
  case "plan":
    State.pendingApproval = {
      requestId: "r2", sessionId: "preview-session", tool: "ExitPlanMode", command: "", taskId: "cc_preview",
      kind: "plan", plan: "1. Tokens and face primitive\n2. Header capsule tabs and pill chips\n3. Cards, alerts, chat\n4. Settings tile grid",
    };
    break;
  case "question":
    State.pendingQuestion = { requestId: "q1", taskId: "cc_preview", items: ASK, index: 0, answers: [] };
    break;
  case "prompt":
    State.chatHistory = [
      { id: 1, role: "user", content: "bonjour Mochi, ringkas PR terakhir" },
      { id: 2, role: "assistant", content: "PR #42 memindahkan amplop Messages ke bawah mata Mochi dan menambah 5 test geometry." },
    ];
    break;
}

const focus = params.get("focus");
if (focus) State.setFocus(focus);

// Pinned, so the auto-close timer never shuts it before the screenshot.
State.isPinned = true;
const root = document.getElementById("root")!;
const island = new Island(root);
island.applySettings();
island.alert(view);
