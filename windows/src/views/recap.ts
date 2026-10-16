// Weekly recap card and its share panel: port of WeeklyRecapCardView and
// RecapSharePanelView (WeeklyRecapView.swift), from upstream 9806b66. The Mac
// shares from a separate panel; here the card flips to a share mode inside the
// island, because a window created after launch comes up blank in WebView2.
//
// Nothing animates in this view: the image is drawn once, when share mode
// opens or the privacy toggle changes.

import { h, clear } from "./dom";
import { Bridge } from "../core/bridge";
import { washRGBA } from "../core/layout";
import { Recap } from "../recap/recap";
import { renderShareImage, toPngBlob, toPngDataUrl } from "../recap/share";
import {
  dayKey, formatCount, formatDuration, weekRangeLabel, type WeeklySummary,
} from "../recap/summary";
import type { ViewActions, ViewHost } from "./views";

/** User-visible strings, in one place. */
const T = {
  title: "Weekly recap",
  noActivity: "No activity last week",
  noActivitySub: "Coucou counts your agent sessions as they happen — check back next Monday.",
  coding: "coding",
  session: "session",
  sessions: "sessions",
  file: "file",
  files: "files",
  lines: "lines",
  commands: "commands",
  topAgent: "Top agent",
  topProject: "Top project",
  busiestDay: "Busiest day",
  longest: "Longest session",
  permissions: "Permissions",
  allowedDenied: (a: number, d: number) => `${a} allowed, ${d} denied`,
  questions: "Questions",
  shareImage: "Share image",
  ok: "OK",
  shareTitle: "Share your week",
  hideProjects: "Hide project names",
  save: "Save image",
  copy: "Copy",
  back: "Back",
  saving: "Saving…",
  savedAs: (name: string) => `Saved as ${name}`,
  showInFolder: "Show in folder",
  copied: "Copied — paste it anywhere.",
  copyUnavailable: "Copying images isn't available here — use Save image.",
};

function btn(label: string, kind: "primary" | "secondary", onClick: () => void): HTMLButtonElement {
  return h("button", { class: `btn ${kind}`, onclick: onClick }, h("span", { text: label }));
}

function chip(value: string, label: string): HTMLElement {
  return h("div", { class: "recap-chip" },
    h("div", { class: "v", text: value }),
    h("div", { class: "l", text: label }),
  );
}

/** "Label value · Label value" — values in white, like the who-row. */
function metaLine(pairs: [string, string][]): HTMLElement | null {
  if (pairs.length === 0) return null;
  const el = h("div", { class: "recap-meta" });
  pairs.forEach(([label, value], i) => {
    if (i > 0) el.append(h("span", { class: "sep", text: "·" }));
    el.append(h("span", { text: label }), h("span", { class: "n", text: value }));
  });
  return el;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The chips: time, sessions, files, then lines and commands when there were any. */
function chipsOf(s: WeeklySummary): HTMLElement {
  const chips = h("div", { class: "recap-chips" },
    chip(formatDuration(s.totalMinutes), T.coding),
    chip(formatCount(s.sessionCount), plural(s.sessionCount, T.session, T.sessions)),
    chip(formatCount(s.filesChanged), plural(s.filesChanged, T.file, T.files)),
  );
  if (s.linesAdded + s.linesRemoved > 0) {
    chips.append(chip(`+${formatCount(s.linesAdded)} / −${formatCount(s.linesRemoved)}`, T.lines));
  }
  if (s.commandsRun > 0) chips.append(chip(formatCount(s.commandsRun), T.commands));
  return chips;
}

/** Top agent, project and busiest day; then the longest session, permissions, questions. */
function metaPairs(s: WeeklySummary): [[string, string][], [string, string][]] {
  const first: [string, string][] = [];
  if (s.topAgent) first.push([T.topAgent, s.topAgent]);
  if (s.topProject) first.push([T.topProject, s.topProject]);
  if (s.busiestDay) first.push([T.busiestDay, s.busiestDay]);
  const second: [string, string][] = [];
  if (s.longestSessionMinutes > 1) second.push([T.longest, formatDuration(s.longestSessionMinutes)]);
  if (s.permissionsAllowed + s.permissionsDenied > 0) {
    second.push([T.permissions, T.allowedDenied(s.permissionsAllowed, s.permissionsDenied)]);
  }
  if (s.questions > 0) second.push([T.questions, formatCount(s.questions)]);
  return [first, second];
}

function summaryBody(s: WeeklySummary, onShare: () => void, onOk: () => void): HTMLElement {
  const [first, second] = metaPairs(s);
  return h("div", { class: "stack recap-stack" },
    h("div", { class: "recap-head" },
      h("span", { class: "recap-title", text: T.title }),
      h("span", { class: "grow" }),
      h("span", { class: "recap-range", text: weekRangeLabel(s) }),
    ),
    chipsOf(s),
    metaLine(first),
    metaLine(second),
    h("div", { class: "actions" }, btn(T.shareImage, "primary", onShare), btn(T.ok, "secondary", onOk)),
  );
}

function emptyBody(onOk: () => void): HTMLElement {
  return h("div", { class: "stack recap-stack" },
    h("div", { class: "title", text: T.noActivity }),
    h("div", { class: "sub", text: T.noActivitySub }),
    h("div", { class: "actions" }, btn(T.ok, "secondary", onOk)),
  );
}

/** The share image's thumbnail, in CSS px. */
const THUMB = { w: 64, h: 114 };

/** Draws the full image into `thumb`, scaled down. */
function drawThumb(thumb: HTMLCanvasElement, image: HTMLCanvasElement) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  thumb.width = Math.round(THUMB.w * dpr);
  thumb.height = Math.round(THUMB.h * dpr);
  const ctx = thumb.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, thumb.width, thumb.height);
}

/** The share panel: the image, the privacy switch, Save, Copy and Back. */
class SharePanel {
  readonly el: HTMLElement;
  private readonly summary: WeeklySummary;
  private readonly thumb = h("canvas", { class: "recap-thumb" }) as HTMLCanvasElement;
  private readonly status = h("div", { class: "recap-status" });
  private image: HTMLCanvasElement | null = null;

  constructor(summary: WeeklySummary, back: () => void) {
    this.summary = summary;
    const sw = h("button", { class: Recap.prefs.hideProjects ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const next = !Recap.prefs.hideProjects;
      sw.classList.toggle("on", next);
      void Recap.setHideProjects(next);
      this.draw();
      clear(this.status);
    });
    this.el = h("div", { class: "stack recap-share" },
      this.thumb,
      h("div", { class: "recap-share-side" },
        h("div", { class: "recap-title", text: T.shareTitle }),
        h("div", { class: "settings-row" }, sw, h("span", { text: T.hideProjects })),
        h("div", { class: "actions" }, this.saveButton(), this.copyButton(), btn(T.back, "secondary", back)),
        this.status,
      ),
    );
    this.draw();
  }

  private draw() {
    this.image = renderShareImage(this.summary, Recap.prefs.hideProjects);
    drawThumb(this.thumb, this.image);
  }

  private say(text: string, extra?: HTMLElement) {
    clear(this.status);
    this.status.append(h("span", { text }));
    if (extra) this.status.append(extra);
  }

  private saveButton(): HTMLButtonElement {
    const save = btn(T.save, "primary", async () => {
      if (!this.image) return;
      save.disabled = true;
      this.say(T.saving);
      try {
        const path = await Bridge.recapSavePng(toPngDataUrl(this.image), dayKey(this.summary.weekStart));
        const name = path.split(/[\\/]/).pop() ?? path;
        const reveal = h("button", { class: "link-btn recap-link", text: T.showInFolder, onclick: () => void Bridge.recapRevealSaved() });
        this.say(T.savedAs(name), reveal);
      } catch (err) {
        this.say(String(err).replace(/^Error:\s*/, ""));
      } finally {
        save.disabled = false;
      }
    });
    return save;
  }

  private copyButton(): HTMLButtonElement {
    return btn(T.copy, "secondary", async () => {
      if (!this.image) return;
      this.say(await copyImage(this.image) ? T.copied : T.copyUnavailable);
    });
  }
}

export function buildRecap(actions: ViewActions): ViewHost {
  const card = h("div", { class: "card wash recap-card" });
  card.style.setProperty("--wash", washRGBA("indigo"));
  const el = h("div", { class: "view" }, card);
  let built = -1;

  const showSummary = () => {
    clear(card);
    const s = Recap.summary;
    const ok = () => actions.collapse();
    card.append(s ? summaryBody(s, () => showShare(s), ok) : emptyBody(ok));
  };
  const showShare = (s: WeeklySummary) => {
    clear(card);
    card.append(new SharePanel(s, showSummary).el);
  };

  return {
    el,
    sync() {
      // Rebuilt only when the recap was (re)loaded, never on every state change:
      // that would reset share mode under the user's cursor.
      if (built === Recap.version) return;
      built = Recap.version;
      showSummary();
    },
  };
}

/**
 * Puts the PNG on the clipboard through the web Clipboard API — no new
 * dependency. It needs the document focused, and the island never takes focus
 * on its own, so it is lent focus for the duration. WebKitGTK builds without
 * image clipboard support say no, and the caller offers Save instead.
 */
async function copyImage(canvas: HTMLCanvasElement): Promise<boolean> {
  const Item = (window as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (!Item || !navigator.clipboard?.write) return false;
  await Bridge.focusWindow(true);
  try {
    const blob = await toPngBlob(canvas);
    if (!blob) return false;
    await navigator.clipboard.write([new Item({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  } finally {
    void Bridge.focusWindow(false);
  }
}
