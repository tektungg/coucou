// Claude Code screen: the hooks. Nothing is written to ~/.claude/settings.json
// until you have seen the exact diff and confirmed it; the write only happens if
// the file still matches what was previewed (bridge.ts hooksApply).

import { Bridge } from "../core/bridge";
import { h, clear } from "../views/dom";
import { hint, notice, panel, renderDiff, row, statusDot, type SettingsCtx } from "./ui";

/** How long the "Done" notice stays before the screen shows the new status. */
const DONE_NOTICE_MS = 2600;

/** The screen's body and how to redraw it, shared by the steps below. */
interface HooksScreen {
  body: HTMLElement;
  ctx: SettingsCtx;
  /** Re-renders the whole Settings screen (the status on its header changed). */
  refresh(): void;
  /** Back to the status and the Install / Uninstall buttons. */
  draw(): void;
}

function statusRows(ctx: SettingsCtx): HTMLElement[] {
  const { hooks } = ctx;
  const out = [
    hint(hooks.installed
      ? "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
      : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing."),
    row("settings.json", h("span", { class: "path", text: hooks.settingsPath })),
    row("Relay", h("span", { class: "path", text: hooks.hookPath }), statusDot(hooks.hookReady)),
  ];
  if (!hooks.hookReady) {
    out.push(notice("warn", "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`."));
  }
  return out;
}

function drawStatus(s: HooksScreen) {
  clear(s.body);
  const install = h("button", {
    class: "primary",
    text: s.ctx.hooks.installed ? "Reinstall hooks…" : "Install hooks…",
    onclick: () => void showPreview(s, true),
  });
  // Hook commands pointing at a relay that isn't there would give every
  // Claude Code session a broken hook and nothing to show for it.
  if (!s.ctx.hooks.hookReady) {
    install.disabled = true;
    install.title = "The relay isn't installed yet.";
  }
  const uninstall = s.ctx.hooks.installed
    ? h("button", { class: "danger", text: "Uninstall hooks…", onclick: () => void showPreview(s, false) })
    : null;
  s.body.append(...statusRows(s.ctx), row(null, install, uninstall));
}

async function showPreview(s: HooksScreen, install: boolean) {
  let preview;
  try {
    preview = await Bridge.hooksPreview(install);
  } catch (err) {
    // An unreadable or invalid settings.json stops here rather than being
    // treated as empty and written over.
    clear(s.body);
    s.body.append(notice("err", String(err).replace(/^Error:\s*/, "")), row(null, h("button", { text: "Back", onclick: s.draw })));
    return;
  }
  if (!preview) return;
  clear(s.body);
  s.body.append(
    hint(install
      ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
      : "This removes Coucou's entries only. Your own hooks are left untouched."),
    renderDiff(preview.diff),
    row(null, h("span", { class: "path", text: `Backup → ${preview.backup}` })),
    row(null, confirmButton(s, install, preview.fingerprint), h("button", { text: "Cancel", onclick: s.draw })),
  );
}

function confirmButton(s: HooksScreen, install: boolean, fingerprint: string): HTMLButtonElement {
  const confirm = h("button", {
    class: install ? "primary" : "danger",
    text: install ? "Back up and write" : "Back up and remove",
  });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      const backup = await Bridge.hooksApply(install, fingerprint);
      clear(s.body);
      s.body.append(notice("ok", `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`));
      window.setTimeout(async () => {
        const fresh = await Bridge.hooksStatus();
        if (fresh) s.ctx.hooks = fresh;
        s.refresh();
      }, DONE_NOTICE_MS);
    } catch (err) {
      confirm.disabled = false;
      s.body.append(notice("err", `Could not write: ${String(err)}`));
    }
  });
  return confirm;
}

export function claudeCodeDetail(ctx: SettingsCtx, refresh: () => void): HTMLElement {
  const s: HooksScreen = { body: h("div", { class: "stack" }), ctx, refresh, draw: () => drawStatus(s) };
  s.draw();
  return panel(null, s.body);
}
