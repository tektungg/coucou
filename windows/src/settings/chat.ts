// Chat screen: how Mochi's chat reaches Claude. An API key (kept in the Windows
// Credential Manager, never on disk) or the Claude Code CLI on your own login.

import { API_KEY_SECRET, Bridge } from "../core/bridge";
import { h, clear } from "../views/dom";
import { DOT_MISSING, DOT_OK, hint, notice, panel, row, select, statusDot, textInput, type SettingsCtx } from "./ui";

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];
const PROVIDERS: [string, string][] = [["api", "API key"], ["cli", "Claude Code login"]];
const STORED = "••••••••••••  (stored)";
const KEY_PLACEHOLDER = "sk-ant-...";

/** The status line and dot under the screen title, for the chosen provider. */
function chatStatus(ctx: SettingsCtx): { ok: boolean; text: string } {
  if (ctx.settings.chatProvider === "cli") {
    return ctx.cli.found
      ? { ok: true, text: `Chat runs through Claude Code at ${ctx.cli.path}. No API key needed.` }
      : { ok: false, text: "Claude Code not found. Install it, or chat with an API key." };
  }
  return ctx.hasKey
    ? { ok: true, text: "Key saved in the Windows Credential Manager." }
    : { ok: false, text: "No key yet. The chat needs one." };
}

/** Save and Remove for the API key; `changed` runs after either. */
function keyRow(ctx: SettingsCtx, feedback: HTMLElement, changed: () => void): HTMLElement {
  const field = textInput({ type: "password", placeholder: ctx.hasKey ? STORED : KEY_PLACEHOLDER });
  const remove = h("button", { class: "danger", text: "Remove" });
  const sync = () => {
    field.placeholder = ctx.hasKey ? STORED : KEY_PLACEHOLDER;
    remove.style.display = ctx.hasKey ? "" : "none";
    changed();
  };
  /** Runs a Credential Manager change; true when it went through. */
  const run = async (action: () => Promise<unknown>, done: string, failed: string): Promise<boolean> => {
    clear(feedback);
    try {
      await action();
      ctx.hasKey = (await Bridge.secretPresent(API_KEY_SECRET)) ?? false;
      feedback.append(notice("ok", done));
      sync();
      return true;
    } catch (err) {
      feedback.append(notice("err", `${failed}: ${String(err)}`));
      return false;
    }
  };
  const save = h("button", { class: "primary", text: "Save key" });
  save.addEventListener("click", () => {
    const value = field.value.trim();
    if (!value) return;
    void run(() => Bridge.secretSet(API_KEY_SECRET, value), "Saved. It never touches disk.", "Could not save")
      .then((saved) => {
        if (saved) field.value = "";
      });
  });
  remove.addEventListener("click", () => void run(() => Bridge.secretClear(API_KEY_SECRET), "Key removed.", "Could not remove"));
  sync();
  return row("API key", field, save, remove);
}

export function chatDetail(ctx: SettingsCtx): HTMLElement {
  const dot = statusDot(false);
  const status = hint("");
  const configDir = textInput({ placeholder: "C:\\Users\\you\\.claude  (empty = default)", value: ctx.settings.claudeConfigDir });
  configDir.addEventListener("change", () => {
    ctx.settings.claudeConfigDir = configDir.value.trim();
    void ctx.save();
  });
  const configRow = row("Config dir", configDir);
  const showMode = () => {
    const s = chatStatus(ctx);
    dot.style.background = s.ok ? DOT_OK : DOT_MISSING;
    status.textContent = s.text;
    configRow.style.display = ctx.settings.chatProvider === "cli" ? "" : "none";
  };
  const provider = select(PROVIDERS, ctx.settings.chatProvider, (v) => {
    ctx.settings.chatProvider = v === "cli" ? "cli" : "api";
    showMode();
    void ctx.save();
  });
  const model = select(MODELS, ctx.settings.model, (v) => {
    ctx.settings.model = v;
    void ctx.save();
  });
  const feedback = h("div", {});
  const key = keyRow(ctx, feedback, showMode);
  showMode();
  return panel(null, h("div", { class: "status-line" }, dot, status),
    row("Chat via", provider), configRow, key, row("Model", model), feedback);
}
