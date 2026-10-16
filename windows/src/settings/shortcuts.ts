// Settings → Shortcuts: the global shortcuts, each with its switch and its
// keys, a recorder for new keys, and the island's own keys read-only. Ported
// from upstream Louis-CFM/coucou (21a8a86, 322e2ab), where it was a section of
// settings/main.ts; laid out with this build's panels and rows.

import { Bridge, type ShortcutStatus, type ShortcutsReport } from "../core/bridge";
import {
  ISLAND_SHORTCUTS, SHORTCUTS, SHORTCUT_TEXT, activeKeys, displayKeys, duplicates, effective, recordPress,
  type Binding, type Recorded, type ShortcutDef,
} from "../core/shortcuts";
import { clear, h } from "../views/dom";
import { hint, notice, panel, toggle, type SettingsCtx } from "./ui";

export const SHORTCUTS_UI = {
  hint: "Work from any app. Click a shortcut to change it, then press the new keys. Esc cancels, Backspace removes it.",
  global: "From anywhere",
  island: "In the open island",
  recording: "Press keys…",
  none: "None",
  reset: "Reset to defaults",
  needsModifier: "Hold Ctrl, Alt or the Windows key with it.",
  unsupportedKey: "That key can't be used in a shortcut.",
  wayland:
    "Your Wayland desktop doesn't let apps listen for keys outside their own windows. Add the shortcuts in your system's keyboard settings instead, with these commands:",
  noDisplay: "No display server was found, so global shortcuts are off.",
  types: (ch: string) => `Types “${ch}”`,
  typesNote: (keys: string, ch: string) => `${keys} types “${ch}” on your keyboard, so it can't be a shortcut. Pick another key.`,
};

/** The tag a shortcut's status shows next to its keys; none when it simply works. */
const STATUS_TAGS: Partial<Record<ShortcutStatus, { cls: string; text: string }>> = {
  inUse: { cls: "tag warn", text: "In use by another app" },
  duplicate: { cls: "tag err", text: "Used twice" },
  invalid: { cls: "tag err", text: "Not a valid shortcut" },
  unsupported: { cls: "tag", text: "Not available" },
};

class ShortcutsScreen {
  readonly el: HTMLElement;
  private readonly ctx: SettingsCtx;
  private report: ShortcutsReport | null = null;
  private readonly list = h("div", { class: "shortcut-list" });
  private readonly feedback = h("div", {});
  private readonly blockedNote = h("div", {});
  private stopRecording: (() => void) | null = null;

  constructor(ctx: SettingsCtx) {
    this.ctx = ctx;
    const reset = h("button", { text: SHORTCUTS_UI.reset, onclick: () => this.reset() });
    this.el = h("div", { class: "stack" },
      panel(SHORTCUTS_UI.global, hint(SHORTCUTS_UI.hint), this.list, this.blockedNote, this.feedback,
        h("div", { class: "row" }, reset)),
      panel(SHORTCUTS_UI.island, islandList()));
    this.draw();
    void this.refreshReport();
  }

  /** Asks Rust how the shortcuts went: taken by another app, typing a character… */
  private async refreshReport() {
    this.report = await Bridge.shortcutsStatus();
    if (!this.stopRecording) this.draw();
  }

  private async store(id: string, binding: Binding) {
    this.ctx.settings.shortcuts = { ...this.ctx.settings.shortcuts, [id]: binding };
    // Rust registers them again on save; the report then says how that went.
    await this.ctx.save();
    await this.refreshReport();
  }

  /** Leaving the screen mid-recording gives the global shortcuts back. */
  stop() {
    this.stopRecording?.();
  }

  private reset() {
    this.stopRecording?.();
    this.ctx.settings.shortcuts = {};
    clear(this.feedback);
    void this.ctx.save().then(() => this.refreshReport());
    this.draw();
  }

  private tagFor(id: string, dups: Set<string>): HTMLElement | null {
    const st = this.report?.actions.find((a) => a.id === id);
    if (!dups.has(id) && st?.status === "typesCharacter") {
      return h("span", { class: "tag warn", text: SHORTCUTS_UI.types(st.typed ?? "?") });
    }
    const tag = dups.has(id) ? STATUS_TAGS.duplicate : st ? STATUS_TAGS[st.status] : undefined;
    return tag ? h("span", { class: tag.cls, text: tag.text }) : null;
  }

  private draw() {
    clear(this.list);
    const stored = this.ctx.settings.shortcuts;
    const dups = duplicates(activeKeys(stored));
    for (const d of SHORTCUTS) {
      if (d.ported) this.list.append(this.shortcutRow(d, effective(d, stored), dups));
    }
    this.drawBlocked();
  }

  private shortcutRow(d: ShortcutDef, binding: Binding, dups: Set<string>): HTMLElement {
    const keycap = h("button", {
      class: "keycap",
      text: binding.keys ? displayKeys(binding.keys) : SHORTCUTS_UI.none,
    }) as HTMLButtonElement;
    keycap.disabled = !binding.enabled;
    keycap.addEventListener("click", () => this.record(d.id, binding, keycap));
    const sw = toggle(binding.enabled, (on) => void this.store(d.id, { keys: binding.keys, enabled: on }).then(() => this.draw()));
    const tag = binding.enabled ? this.tagFor(d.id, dups) : null;
    return h("div", { class: binding.enabled ? "row shortcut" : "row shortcut off" },
      sw, h("span", { class: "shortcut-name", text: SHORTCUT_TEXT[d.id] }), tag, keycap);
  }

  /** Where no global shortcut can be registered, says so (and, on Wayland, what to add instead). */
  private drawBlocked() {
    clear(this.blockedNote);
    const report = this.report;
    if (report?.blocked === "wayland") {
      const commands = h("div", { class: "diff" });
      for (const d of SHORTCUTS) {
        if (d.ported) commands.append(h("div", { class: "ctx", text: `${report.command} ${d.id}` }));
      }
      this.blockedNote.append(notice("warn", SHORTCUTS_UI.wayland), commands);
    } else if (report?.blocked) {
      this.blockedNote.append(notice("warn", SHORTCUTS_UI.noDisplay));
    }
  }

  /** Listens for the new keys; the global shortcuts let go meanwhile, so they reach here. */
  private record(id: string, binding: Binding, button: HTMLButtonElement) {
    this.stopRecording?.();
    clear(this.feedback);
    button.classList.add("recording");
    button.textContent = SHORTCUTS_UI.recording;
    void Bridge.shortcutsSuspend(true);

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.recorded(id, binding, recordPress(e), finish);
    };
    const finish = () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", finish);
      this.stopRecording = null;
      // Takes the global shortcuts back, from what is saved by now.
      void Bridge.shortcutsSuspend(false);
      this.draw();
    };
    this.stopRecording = finish;
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", finish);
  }

  /** What a press in the recorder does: keep listening, store, or say why not. */
  private recorded(id: string, binding: Binding, result: Recorded, finish: () => void) {
    if (result.kind === "pending") return;
    if (result.kind === "needsModifier" || result.kind === "unsupported") {
      const text = result.kind === "needsModifier" ? SHORTCUTS_UI.needsModifier : SHORTCUTS_UI.unsupportedKey;
      this.feedback.replaceChildren(notice("warn", text));
      return;
    }
    finish();
    if (result.kind === "keys") void this.store(id, { keys: result.keys, enabled: true });
    else if (result.kind === "clear") void this.store(id, { keys: "", enabled: binding.enabled });
    else if (result.kind === "typesCharacter") {
      this.feedback.append(notice("warn", SHORTCUTS_UI.typesNote(displayKeys(result.keys), result.typed)));
    }
  }
}

/** The island's own keys, read-only (ShortcutLogic.islandShortcuts). */
function islandList(): HTMLElement {
  const list = h("div", { class: "shortcut-list" });
  for (const row of ISLAND_SHORTCUTS) {
    list.append(h("div", { class: "row shortcut" },
      h("span", { class: "shortcut-name", text: row.description }),
      h("span", { class: "keycap static", text: row.keys })));
  }
  return list;
}

/** The screen on display, so leaving it can end a recording. */
let shown: ShortcutsScreen | null = null;

export function shortcutsDetail(ctx: SettingsCtx): HTMLElement {
  shown = new ShortcutsScreen(ctx);
  return shown.el;
}

/** Settings is about to draw another screen. */
export function leaveShortcuts() {
  shown?.stop();
  shown = null;
}
