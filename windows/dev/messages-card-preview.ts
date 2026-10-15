// Dev harness: the Messages card (views/messagesCard.ts) in a plain browser,
// with fake chats, so its layout can be checked without Discord or WhatsApp.
// Not part of the app bundle. With `npm run dev`, open
// http://127.0.0.1:1420/dev/messages-card-preview.html
//   ?many      9 messages over 3 apps, 5 of them in one group
//   ?one       one app only, so no filter chips
//   ?long      long names and a multi-line message
//   ?expanded  the first chat opened to every message
//   ?hover     the first row as if the pointer were on it (✓ and ⌄ showing)
//   ?filter=whatsapp  the card narrowed to one app by its chip

const params = new URLSearchParams(location.search);
const now = Date.now();
const min = 60_000;

// Bridge only talks to Rust when Tauri is there: fake it before the app modules load.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async () => null,
};

type Msg = { id: number; app: string; sender: string; place?: string; channel?: string; text: string; at: number };

function fixture(): Msg[] {
  if (params.has("one")) {
    return [
      { id: 3, app: "telegram", sender: "ダーリン", text: "You have a new message", at: now - 20_000 },
      { id: 2, app: "telegram", sender: "Budi", place: "Dev Squad", text: "Deploy jam 3 ya", at: now - 5 * min },
    ];
  }
  if (params.has("long")) {
    return [
      { id: 3, app: "discord", sender: "Aurelia Montgomery-Kusumawardhani", place: "Indie Game Makers Collective",
        channel: "#show-and-tell-weekly", text: "Here is the build\nPatch notes are in the thread, tell me what breaks first", at: now - 40_000 },
      { id: 2, app: "slack", sender: "Rizky", place: "Venturo", channel: "#release", text: "QA passed on staging, waiting for the go from product before we push it to production tonight", at: now - 9 * min },
      { id: 1, app: "whatsapp", sender: "Mama", text: "Nanti pulang jam berapa?", at: now - 2 * 60 * min },
    ];
  }
  if (params.has("many")) {
    return [
      { id: 9, app: "telegram", sender: "Budi", place: "Dev Squad", text: "Udah aku merge ya", at: now - 15_000 },
      { id: 8, app: "whatsapp", sender: "Mama", text: "Nanti pulang jam berapa?", at: now - 2 * min },
      { id: 7, app: "telegram", sender: "Sari", place: "Dev Squad", text: "Oke, aku cek staging", at: now - 3 * min },
      { id: 6, app: "discord", sender: "nekomata", place: "Tauri", channel: "#help", text: "try pinning tauri-runtime-wry", at: now - 6 * min },
      { id: 5, app: "telegram", sender: "Budi", place: "Dev Squad", text: "PR #42 siap direview", at: now - 8 * min },
      { id: 4, app: "whatsapp", sender: "Rani", text: "Besok jadi futsal?", at: now - 25 * min },
      { id: 3, app: "telegram", sender: "Dimas", place: "Dev Squad", text: "Build hijau semua", at: now - 40 * min },
      { id: 2, app: "telegram", sender: "ダーリン", text: "You have a new message", at: now - 70 * min },
      { id: 1, app: "telegram", sender: "Sari", place: "Dev Squad", text: "Deploy jam 3 ya", at: now - 3 * 60 * min },
    ];
  }
  return [
    { id: 3, app: "telegram", sender: "ダーリン", text: "You have a new message", at: now - 20_000 },
    { id: 2, app: "whatsapp", sender: "Mama", text: "Nanti pulang jam berapa?", at: now - 2 * min },
    { id: 1, app: "telegram", sender: "Budi", place: "Dev Squad", text: "Deploy jam 3 ya", at: now - 5 * min },
  ];
}

const { State, INTEGRATION_AGENTS } = await import("../src/core/state");
await import("../src/style.css");
const { renderPersonalCard } = await import("../src/views/personal");

State.mode = "expanded";
State.integrations.integration_messages = { loaded: true, configured: true, error: null, data: { messages: fixture() } };

// :hover can't be forced from a script: copy the row's hover rules onto a class.
if (params.has("hover")) {
  for (const sheet of [...document.styleSheets]) {
    for (const rule of [...sheet.cssRules]) {
      if (rule instanceof CSSStyleRule && rule.selectorText.includes(".msg-row:hover")) {
        sheet.insertRule(`${rule.selectorText.replaceAll(".msg-row:hover", ".msg-row.hovered")} { ${rule.style.cssText} }`, sheet.cssRules.length);
      }
    }
  }
}

const task = INTEGRATION_AGENTS.find((t) => t.id === "integration_messages")!;
const frame = document.createElement("div");
frame.className = "frame";
frame.append(document.createElement("div"));
frame.firstElementChild!.className = "mochi";
const card = renderPersonalCard(task, false, () => {}, () => {});
if (card) frame.append(card);
document.getElementById("cards")!.append(frame);

const first = () => frame.querySelector<HTMLElement>(".msg-row");
if (params.has("expanded")) first()?.querySelector<HTMLElement>(".msg-act.more")?.click();
if (params.has("hover")) first()?.classList.add("hovered");
const f = params.get("filter");
if (f) [...frame.querySelectorAll<HTMLElement>(".msg-chip")].find((c) => c.textContent?.toLowerCase().startsWith(f))?.click();
