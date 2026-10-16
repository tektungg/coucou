// Chat screen: who Mochi's chat talks to. A cloud provider with its key (kept in
// the Windows Credential Manager, never on disk), a model server you run
// yourself, or the Claude Code CLI on your own login. The model is picked from
// the chat itself (the model name above the text field).

import { PROVIDERS, providerDef, type ProviderId } from "../core/providers";
import { h } from "../views/dom";
import { keysPanel } from "./chatKeys";
import { localPanel } from "./chatLocal";
import { DOT_MISSING, DOT_OK, hint, panel, row, select, statusDot, textInput, type SettingsCtx } from "./ui";

/** The status line under the screen title, for the provider in use. */
export function chatStatus(ctx: SettingsCtx): { ok: boolean; text: string } {
  const s = ctx.settings;
  const p = providerDef(s.chatProvider);
  if (p.id === "claude-cli") {
    return ctx.cli.found
      ? { ok: true, text: `Chat runs through Claude Code at ${ctx.cli.path}. No API key needed.` }
      : { ok: false, text: "Claude Code not found. Install it, or pick another provider." };
  }
  if (p.urlField) {
    return s[p.urlField]
      ? { ok: true, text: `Chat runs on ${p.name} at ${s[p.urlField]}.` }
      : { ok: false, text: `${p.name} is not connected yet: connect it under Local models.` };
  }
  const saved = p.id === "anthropic" ? ctx.hasKey : ctx.present[p.key ?? ""] === true;
  return saved
    ? { ok: true, text: `Chat runs on ${p.name}. Its key is in the Windows Credential Manager.` }
    : { ok: false, text: `No ${p.name} key yet: add it under API keys.` };
}

function providerOptions(): [string, string][] {
  return PROVIDERS.map((p) => [p.id, p.id === "custom" ? "OpenAI-compatible server" : p.name]);
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
  const provider = select(providerOptions(), ctx.settings.chatProvider, (v) => {
    ctx.settings.chatProvider = providerDef(v).id as ProviderId;
    showMode();
    void ctx.save();
  });
  const showMode = () => {
    const s = chatStatus(ctx);
    dot.style.background = s.ok ? DOT_OK : DOT_MISSING;
    status.textContent = s.text;
    configRow.style.display = ctx.settings.chatProvider === "claude-cli" ? "" : "none";
    provider.value = ctx.settings.chatProvider;
  };
  const main = panel(null, h("div", { class: "status-line" }, dot, status),
    row("Chat via", provider), configRow,
    hint("Switch the model from the chat: click its name above the text field."));
  const screen = h("div", { class: "stack" }, main, keysPanel(ctx, () => showMode()), localPanel(ctx, () => showMode()));
  showMode();
  return screen;
}
