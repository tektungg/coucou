// Chat view: DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift, with upstream Louis-CFM/coucou's provider picker and
// streaming (741aab2).
//
// Answers are rendered as Markdown (markdown.ts). A local model streams its
// answer: Rust sends `chat-delta` events with the text visible so far. The
// model name above the text field opens the picker (chatPicker.ts).

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./markdown";
import { ChatPicker } from "./chatPicker";
import { Bridge, onEvent, type ChatContext } from "../core/bridge";
import { activeModel, providerDef } from "../core/providers";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";

const STRINGS = {
  placeholderFirst: "Ask me anything…",
  placeholderNext: "Continue…",
  send: "Send",
  switchModel: "Switch provider or model",
  noModel: "Choose a model",
};

let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply" });
  renderMarkdown(reply, message.content);
  return h("div", { class: "chat-row" }, reply);
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

class ChatView {
  readonly el: HTMLElement;
  private readonly chipRow = h("div", { class: "chip-row" });
  private readonly log = h("div", { class: "chat-log" });
  private readonly input = h("input", {
    type: "text", class: "chat-input", placeholder: STRINGS.placeholderFirst, spellcheck: "false",
  }) as HTMLInputElement;
  private readonly body = h("div", { class: "chat-body" });
  private readonly modelDot = h("i", { class: "model-dot" });
  private readonly modelName = h("span", { class: "model-name" });
  private readonly modelBtn: HTMLButtonElement;
  private readonly picker: ChatPicker;
  private readonly onHeightChange: () => void;

  private sending = false;
  private renderedCount = -1;
  /** A local model answers token by token: where its text so far is shown. */
  private live: HTMLElement | null = null;

  constructor(onHeightChange: () => void) {
    this.onHeightChange = onHeightChange;
    const send = h("button", { class: "send-btn", title: STRINGS.send }, svg(ICONS.arrowUp, 11));
    this.modelBtn = h("button", { class: "model-btn", title: STRINGS.switchModel },
      this.modelDot, this.modelName, svg(ICONS.chevronUpDown, 9, { stroke: 2 })) as HTMLButtonElement;
    this.picker = new ChatPicker(() => {
      this.body.classList.toggle("picking", this.picker.isOpen);
      this.drawModelButton();
    });
    this.body.append(this.chipRow, this.log, this.picker.el, h("div", { class: "model-row" }, this.modelBtn),
      h("div", { class: "chat-bar" }, this.input, send));
    this.el = h("div", { class: "view" }, h("div", { class: "card wash chat-card" }, this.body));
    (this.el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

    this.modelBtn.addEventListener("click", () => this.togglePicker());
    send.addEventListener("click", () => void this.submit());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    void onEvent<string>("chat-delta", (text) => this.onDelta(text));
  }

  private drawModelButton() {
    this.modelDot.style.background = providerDef(State.settings.chatProvider).accent;
    this.modelName.textContent = activeModel(State.settings) || STRINGS.noModel;
    this.modelBtn.classList.toggle("open", this.picker.isOpen);
    this.modelBtn.disabled = this.sending;
  }

  private togglePicker() {
    if (this.sending) return;
    if (this.picker.isOpen) this.picker.hide();
    else this.picker.show();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void this.submit();
    } else if (e.key === "Escape" && this.picker.isOpen) {
      e.preventDefault();
      this.picker.hide();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  }

  /** The text so far of a streamed answer; nothing visible yet keeps the dots. */
  private onDelta(text: string) {
    if (!this.sending || !text) return;
    if (!this.live) {
      this.live = h("div", { class: "reply" });
      this.log.querySelector(".typing")?.parentElement?.remove();
      this.log.append(h("div", { class: "chat-row" }, this.live));
    }
    renderMarkdown(this.live, text);
    this.log.scrollTop = this.log.scrollHeight;
  }

  private begin(query: string) {
    if (this.picker.isOpen) this.picker.hide();
    this.input.value = "";
    this.sending = true;
    this.drawModelButton();
    Sound.play("send");
    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    this.onHeightChange();
  }

  private async submit() {
    const query = this.input.value.trim();
    if (!query || this.sending) return;
    this.begin(query);
    // The dropped file rides along with the first question only.
    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;
    try {
      const reply = await Bridge.chatSend(query, context);
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      this.finish();
    }
  }

  private finish() {
    this.sending = false;
    this.live = null;
    this.renderedCount = -1; // the finished answer replaces the streamed one
    this.drawModelButton();
    State.notify();
    this.onHeightChange();
    this.input.focus();
  }

  private syncChip() {
    const wantChip = State.droppedFile?.name ?? "";
    if (this.chipRow.dataset.label === wantChip) return;
    this.chipRow.dataset.label = wantChip;
    clear(this.chipRow);
    if (wantChip) this.chipRow.append(contextChip(wantChip));
  }

  private syncLog() {
    const thinking = State.stateOverride === "thinking";
    const count = State.chatHistory.length + (thinking ? 0.5 : 0);
    if (count === this.renderedCount || this.live) return;
    this.renderedCount = count;
    clear(this.log);
    for (const m of State.chatHistory) this.log.append(bubble(m));
    if (thinking) this.log.append(typingDots());
    this.log.scrollTop = this.log.scrollHeight;
  }

  sync() {
    this.syncChip();
    this.syncLog();
    // Leaving the chat folds the picker away.
    if (State.view !== "prompt" && this.picker.isOpen) this.picker.hide();
    this.drawModelButton();
    this.input.placeholder = State.chatHistory.length === 0 ? STRINGS.placeholderFirst : STRINGS.placeholderNext;
    this.input.disabled = this.sending;
  }

  focus() {
    this.input.focus();
    this.input.select();
  }
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const view = new ChatView(onHeightChange);
  return { el: view.el, sync: () => view.sync(), focus: () => view.focus() };
}
