// Dev harness: the real island (island/island.ts), opened on one view with fake
// sessions, pills and cards, so the Mochi Pop look can be checked in a plain
// browser without Claude Code, Spotify or a phone. Not part of the app bundle.
// With `npm run dev`, open http://127.0.0.1:1420/dev/pop-preview.html
//   ?view=overview|prompt|approval|question|settings|plan|finished|error|empty
//   &focus=<pill id>   (overview only; default: the session pill)
//   &many              four agent sessions instead of two (the board's +N)
//   &diff              the working session has just edited a file (+N −M chip)
//   &diff=open         …and its diff card is open
//   view=recap[&share] the weekly recap of the sample week (its share panel)
//   &focus=integration_github[&detail]  the GitHub pulse card (its lists)
//   &outfit=<selection>  what Mochi wears (mochi/wardrobe.ts); view=wardrobe for the wardrobe
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
  // getCurrentWebview() (the file drop listener) reads these labels.
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
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
State.settings.mochiOutfit = params.get("outfit") ?? "none";
State.loadIntegrationTasks();
State.upsertSession("cc_preview", "preview-session", "coucou", "D:/Personal Project/coucou");
State.updateTask("cc_preview", "working");
State.appendStep("cc_preview", "Editing engine.ts");
State.upsertSession("cc_api", "api-session", "venturo-api", "D:/Work/api");
State.updateTask("cc_api", "finished");
// ?diff: the session's last step is a file edit, with the diff kept for the card.
if (params.has("diff")) {
  const { fromEdit, fileName, makeDiffStep } = await import("../src/core/diff");
  const { sessionDiffs } = await import("../src/core/sessionDiffs");
  const before = [
    "export function greet(name) {", "  return `hi ${name}`;", "}", "", "export const VERSION = 1;", "",
  ].join("\n");
  const after = [
    "export function greet(name: string): string {", "  const who = name.trim() || \"you\";",
    "  return `hi ${who}`;", "}", "", "export const VERSION = 2;", "",
  ].join("\n");
  const diff = fromEdit(before, after, "D:/Personal Project/coucou/windows/src/greet.ts");
  const id = sessionDiffs.append("cc_preview", diff);
  State.appendStep("cc_preview", makeDiffStep(fileName(diff.path), diff.added, diff.removed, id));
}
Object.assign(State.tasks.find((t) => t.id === "cc_preview")!, { ctxPct: 41, costUsd: 1.2 });
// ?many: two more sessions, one waiting on you, so the board folds into +N.
if (params.has("many")) {
  State.upsertSession("cc_web", "web-session", "landing-page", "D:/Work/web");
  State.updateTask("cc_web", "approval");
  State.upsertSession("cc_docs", "docs-session", "docs", "D:/Work/docs");
}
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
// The GitHub pulse: two PRs of mine, one review waiting, two default branches.
if (params.get("focus") === "integration_github") {
  State.settings.activeIntegrations = ["integration_github", ...State.settings.activeIntegrations.slice(0, 5)];
  State.loadIntegrationTasks();
  const pr = (repo: string, number: number, title: string, ci: string, review: string) => ({
    id: `${repo}#${number}`, title, url: `https://github.com/${repo}/pull/${number}`, repo, number,
    isDraft: false, ci, review, headSha: null,
  });
  const day = (i: number) => ({
    date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, count: i % 5, level: (i * 7) % 5, weekday: i % 7,
  });
  State.integrations.integration_github = ok({
    totalRepos: 24, totalStars: 312,
    pulse: {
      login: "tektungg", fetchedAt: now,
      myPRs: [pr("tektungg/coucou", 42, "Port the live diff to the board", "pending", "pending"),
        pr("tektungg/coucou", 41, "Weekly recap card", "success", "approved")],
      toReview: [pr("venturo/api", 318, "Retry the token refresh once", "failure", "pending")],
      mainCI: [
        { repo: "tektungg/coucou", url: "https://github.com/tektungg/coucou", branch: "main", ci: "success", headSha: null },
        { repo: "venturo/api", url: "https://github.com/venturo/api", branch: "main", ci: "failure", headSha: null },
      ],
    },
    activity: {
      total: 912, fetchedAt: now,
      weeks: Array.from({ length: 20 }, (_, w) => Array.from({ length: 7 }, (_, d) => day(w * 7 + d))),
    },
  });
}
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
      { id: 1, role: "user", content: "bonjour Mochi, sum up the last PR" },
      { id: 2, role: "assistant", content: "PR #42 moves the Messages envelope below your eyes, sorry, mine, and adds 5 geometry tests." },
    ];
    break;
}

const focus = params.get("focus");
if (focus) State.setFocus(focus);
else State.setFocus("cc_preview");

// Pinned, so the auto-close timer never shuts it before the screenshot.
State.isPinned = true;
const root = document.getElementById("root")!;
const island = new Island(root);
island.applySettings();
if (view === "recap") {
  const { Recap } = await import("../src/recap/recap");
  const { previousWeekStart, sampleHistory, summarize } = await import("../src/recap/summary");
  const start = previousWeekStart(new Date());
  Recap.summary = summarize(sampleHistory(start), start);
  Recap.version++;
}
island.alert(view);
if (view === "recap" && params.has("share")) {
  window.setTimeout(() => (document.querySelector(".recap-stack .btn.primary") as HTMLElement | null)?.click(), 400);
}
if (params.has("detail")) {
  window.setTimeout(() => (document.querySelector(".gh-stat") as HTMLElement | null)?.click(), 400);
}
if (params.get("diff") === "open") {
  window.setTimeout(() => (document.querySelector(".btile-diff") as HTMLElement | null)?.click(), 400);
}
