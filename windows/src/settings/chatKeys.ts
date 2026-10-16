// Settings → Chat → API keys: one row per cloud provider (Anthropic, Google AI,
// OpenAI, OpenRouter), each key kept in the Windows Credential Manager, never on
// disk. The page only learns whether a key is there. Ported from upstream
// Louis-CFM/coucou (e7a4831, "Chat providers"), laid out in this build's panels.

import { API_KEY_SECRET, Bridge } from "../core/bridge";
import { providerDef, type ProviderId } from "../core/providers";
import { h, clear } from "../views/dom";
import { hint, notice, panel, row, textInput, type SettingsCtx } from "./ui";

const STORED = "••••••••••••  (stored)";

interface CloudDef {
  id: ProviderId;
  name: string;
  placeholder: string;
  /** Where the key is made. */
  where: string;
}

const CLOUD: readonly CloudDef[] = [
  { id: "anthropic", name: "Anthropic", placeholder: "sk-ant-…", where: "console.anthropic.com" },
  { id: "google", name: "Google AI", placeholder: "AIza…", where: "aistudio.google.com" },
  { id: "openai", name: "OpenAI", placeholder: "sk-…", where: "platform.openai.com" },
  { id: "openrouter", name: "OpenRouter", placeholder: "sk-or-…", where: "openrouter.ai/keys" },
];

/** The chat providers' key names, for the Settings window to ask about at load. */
export const CHAT_KEYS: readonly string[] = CLOUD.map((c) => providerDef(c.id).key ?? "").filter(
  (k) => k && k !== API_KEY_SECRET,
);

function isPresent(ctx: SettingsCtx, key: string): boolean {
  return key === API_KEY_SECRET ? ctx.hasKey : ctx.present[key] === true;
}

function setPresent(ctx: SettingsCtx, key: string, on: boolean) {
  if (key === API_KEY_SECRET) ctx.hasKey = on;
  else ctx.present[key] = on;
}

/** Save and Remove for one provider's key; `changed` runs after either. */
function keyRow(ctx: SettingsCtx, def: CloudDef, feedback: HTMLElement, changed: () => void): HTMLElement {
  const key = providerDef(def.id).key ?? "";
  const field = textInput({ type: "password", placeholder: def.placeholder });
  const save = h("button", { class: "primary", text: "Save" });
  const remove = h("button", { class: "danger", text: "Remove" });
  const sync = () => {
    field.placeholder = isPresent(ctx, key) ? STORED : def.placeholder;
    remove.style.display = isPresent(ctx, key) ? "" : "none";
  };
  /** A Credential Manager change, then what is stored now. */
  const run = async (action: () => Promise<unknown>, done: string) => {
    clear(feedback);
    try {
      await action();
      setPresent(ctx, key, (await Bridge.secretPresent(key)) ?? false);
      feedback.append(notice("ok", done));
      field.value = "";
    } catch (err) {
      feedback.append(notice("err", `${def.name}: ${String(err)}`));
    }
    sync();
    changed();
  };
  save.addEventListener("click", () => {
    const value = field.value.trim();
    if (value) void run(() => Bridge.secretSet(key, value), `${def.name} key saved. It never touches disk.`);
  });
  remove.addEventListener("click", () => void run(() => Bridge.secretClear(key), `${def.name} key removed.`));
  sync();
  field.title = `Key from ${def.where}`;
  return row(def.name, field, save, remove);
}

export function keysPanel(ctx: SettingsCtx, changed: () => void): HTMLElement {
  const feedback = h("div", {});
  const rows = CLOUD.map((def) => keyRow(ctx, def, feedback, changed));
  return panel("API keys",
    hint("Add a key, then click the model name above the chat box to switch provider and model. Google AI, OpenAI and OpenRouter get no web search and no tools: they can answer, never act on this computer."),
    ...rows, feedback);
}
