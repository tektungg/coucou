// Settings → Chat → Local models: Ollama, LM Studio or any server that speaks
// the OpenAI API. Connect checks the server and lists its models; once
// connected it can be used in the chat, or disconnected. Ported from upstream
// Louis-CFM/coucou (e7a4831, 5bddaec), laid out in this build's panels. The
// custom server's key is stored with the address it was entered for and only
// ever sent there (chat/local_chat.rs BoundKey).

import { Bridge } from "../core/bridge";
import { CUSTOM_SERVER_KEY, providerDef, urlExposure, type ProviderDef } from "../core/providers";
import { h, clear } from "../views/dom";
import { hint, notice, panel, row, statusDot, textInput, type SettingsCtx } from "./ui";

type LocalId = "ollama" | "lmstudio" | "custom";
type UrlField = "ollamaUrl" | "lmstudioUrl" | "customUrl";

const LOCAL: Record<LocalId, { name: string; usual: string }> = {
  ollama: { name: "Ollama", usual: "http://127.0.0.1:11434" },
  lmstudio: { name: "LM Studio", usual: "http://127.0.0.1:1234" },
  // No usual address: any server that speaks the OpenAI API.
  custom: { name: "OpenAI-compatible", usual: "" },
};

export const LOCAL_TEXT = {
  hint: "Chat with a model you run yourself: Ollama or LM Studio (leave the address empty for the usual one on this computer), or any server that speaks the OpenAI API, such as vLLM or llama.cpp.",
  connect: "Connect",
  connecting: "Connecting…",
  disconnect: "Disconnect",
  useInChat: "Use in chat",
  inUse: "In use",
  keyOptional: "API key (optional)",
  stored: "••••••••  (stored)",
  localOnly: "Nothing leaves your PC: the server runs on this computer.",
  remote: "This address is another machine: what you ask is sent to it.",
  remoteHttp: "This address is another machine, over plain http: what you ask travels unencrypted.",
  keyOverHttp: "The key is only sent over https:// or to this computer, so it will not go to this address.",
  invalid: "Not a valid http:// or https:// address.",
  noModels: (name: string) => `No models yet. Download one in ${name} first.`,
};

const errorText = (err: unknown) => String(err).replace(/^Error:\s*/, "");

/** What an address means for what you type, as a hint or a notice; null for an empty invalid field. */
export function exposureNotice(url: string, withKey: boolean): HTMLElement | null {
  switch (urlExposure(url)) {
    case "local":
      return hint(LOCAL_TEXT.localOnly);
    case "remote":
      return hint(LOCAL_TEXT.remote);
    case "remote-http":
      return withKey ? notice("warn", LOCAL_TEXT.keyOverHttp) : hint(LOCAL_TEXT.remoteHttp);
    case "invalid":
      return url.trim() ? notice("err", LOCAL_TEXT.invalid) : null;
  }
}

class LocalPanel {
  readonly el: HTMLElement;
  private readonly body = h("div", { class: "stack" });
  private readonly ctx: SettingsCtx;
  private readonly changed: () => void;

  constructor(ctx: SettingsCtx, changed: () => void) {
    this.ctx = ctx;
    this.changed = changed;
    this.el = panel("Local models", hint(LOCAL_TEXT.hint), this.body);
    this.redraw();
  }

  private redraw() {
    clear(this.body);
    for (const id of Object.keys(LOCAL) as LocalId[]) this.body.append(this.server(id));
    this.changed();
  }

  private field(p: ProviderDef): UrlField {
    return p.urlField as UrlField;
  }

  private server(id: LocalId): HTMLElement {
    const p = providerDef(id);
    const label = h("label", {}, h("i", { class: "dot", style: `background:${p.accent};margin-right:8px` }),
      h("span", { text: LOCAL[id].name }));
    return this.ctx.settings[this.field(p)] ? this.connected(id, p, label) : this.connectForm(id, p, label);
  }

  /** A connected server: where it is, Use in chat, Disconnect, and what the address means. */
  private connected(id: LocalId, p: ProviderDef, label: HTMLElement): HTMLElement {
    const s = this.ctx.settings;
    const url = s[this.field(p)];
    const inUse = s.chatProvider === id;
    const use = h("button", { class: inUse ? "" : "primary", text: inUse ? LOCAL_TEXT.inUse : LOCAL_TEXT.useInChat });
    use.toggleAttribute("disabled", inUse);
    use.addEventListener("click", () => {
      s.chatProvider = id;
      void this.ctx.save().then(() => this.redraw());
    });
    const disconnect = h("button", { class: "danger", text: LOCAL_TEXT.disconnect });
    disconnect.addEventListener("click", () => void this.disconnect(id, p));
    const customKey = id === "custom" && this.ctx.present[CUSTOM_SERVER_KEY] === true;
    return h("div", { class: "stack" },
      row(null, label, h("span", { class: "path", text: url }), statusDot(true), use, disconnect),
      exposureNotice(url, customKey));
  }

  private async disconnect(id: LocalId, p: ProviderDef) {
    const s = this.ctx.settings;
    s[this.field(p)] = "";
    if (s.chatProvider === id) s.chatProvider = "anthropic";
    if (id === "custom") {
      await Bridge.localSetKey("", "").catch(() => {});
      this.ctx.present[CUSTOM_SERVER_KEY] = false;
    }
    await this.ctx.save();
    this.redraw();
  }

  /** Not connected yet: the address (empty = the usual one), the custom server's key, Connect. */
  private connectForm(id: LocalId, p: ProviderDef, label: HTMLElement): HTMLElement {
    const usual = LOCAL[id].usual;
    const input = textInput({ placeholder: usual || "https://llm.example.com" });
    const key = textInput({
      type: "password",
      placeholder: this.ctx.present[CUSTOM_SERVER_KEY] ? LOCAL_TEXT.stored : LOCAL_TEXT.keyOptional,
    });
    const status = h("div", {});
    const exposure = h("div", {});
    const showExposure = () => {
      const withKey = id === "custom" && (this.ctx.present[CUSTOM_SERVER_KEY] === true || key.value.trim() !== "");
      // The custom server has no usual address: nothing to say until one is typed.
      const url = input.value || usual;
      exposure.replaceChildren((url ? exposureNotice(url, withKey) : null) ?? "");
    };
    input.addEventListener("input", showExposure);
    key.addEventListener("input", showExposure);
    const connect = h("button", { class: "primary", text: LOCAL_TEXT.connect }) as HTMLButtonElement;
    connect.addEventListener("click", () => void this.connect({ id, p, input, key, status, connect }));
    showExposure();
    return h("div", { class: "stack" }, row(null, label, input, connect),
      id === "custom" ? row(null, h("label", { text: "" }), key) : null, status, exposure);
  }

  private async connect(f: {
    id: LocalId; p: ProviderDef; input: HTMLInputElement; key: HTMLInputElement;
    status: HTMLElement; connect: HTMLButtonElement;
  }) {
    f.connect.disabled = true;
    f.status.replaceChildren(hint(LOCAL_TEXT.connecting));
    try {
      if (f.id === "custom" && f.key.value.trim()) {
        // Stored with this address: the key is only ever sent there.
        await Bridge.localSetKey(f.input.value || LOCAL[f.id].usual, f.key.value.trim());
        f.key.value = "";
        this.ctx.present[CUSTOM_SERVER_KEY] = true;
      }
      const server = await Bridge.localConnect(f.id, f.input.value);
      if (server.models.length) {
        await this.keepServer(f.id, f.p, server.url, server.models);
        return;
      }
      f.status.replaceChildren(notice("err", LOCAL_TEXT.noModels(LOCAL[f.id].name)));
    } catch (err) {
      f.status.replaceChildren(notice("err", errorText(err)));
    }
    f.connect.disabled = false;
  }

  /** The server answered with models: keep its address, and a model it offers. */
  private async keepServer(id: LocalId, p: ProviderDef, url: string, models: string[]) {
    const s = this.ctx.settings;
    s[this.field(p)] = url;
    if (!models.includes(s.chatModels[id] ?? "")) s.chatModels = { ...s.chatModels, [id]: models[0] };
    await this.ctx.save();
    this.redraw();
  }
}

export function localPanel(ctx: SettingsCtx, changed: () => void): HTMLElement {
  return new LocalPanel(ctx, changed).el;
}
