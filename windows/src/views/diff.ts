// Diff card: the file a session just edited, line by line. Port of DiffCardView
// / DiffLineRowView (IslandViewContent.swift) from upstream (Louis-CFM/coucou
// 122e130), in the Mochi Pop look. Opens in Home's card when a board tile's
// +N −M is clicked (views/overview.ts).

import { fileName, type DiffKind, type FileDiff } from "../core/diff";
import { h, svg } from "./dom";
import { ICONS } from "./icons";

const STRINGS = {
  back: "Back to the sessions",
  open: "Open in VS Code",
  tooLarge: "Too large to show line by line",
  noChanges: "No changes",
};

const SYMBOLS: Record<DiffKind, string> = { added: "+", removed: "−", context: " " };

export interface DiffCardHooks {
  dismiss(): void;
  /** ↗: opens the file in the editor. */
  open(path: string): void;
}

/** "+12 −3", as the chip on a board tile and the card's head show it. */
export function diffCounts(added: number, removed: number): HTMLElement {
  return h("span", { class: "diff-counts" },
    added > 0 ? h("span", { class: "plus", text: `+${added}` }) : null,
    removed > 0 ? h("span", { class: "minus", text: `−${removed}` }) : null);
}

function diffHead(diff: FileDiff, hooks: DiffCardHooks): HTMLElement {
  return h("div", { class: "diff-head" },
    h("button", { class: "diff-back", title: STRINGS.back, onclick: () => hooks.dismiss() },
      svg(ICONS.chevronLeft, 10, { stroke: 2.4 }),
      h("b", { text: fileName(diff.path) })),
    diffCounts(diff.added, diff.removed),
    h("span", { class: "grow" }),
    h("button", { class: "icon-btn", title: STRINGS.open, onclick: () => hooks.open(diff.path) },
      svg(ICONS.arrowUpRight, 8)));
}

function diffBody(diff: FileDiff): HTMLElement {
  const lines = diff.hunks.flatMap((hunk) => hunk.lines);
  if (diff.tooLarge) return h("div", { class: "diff-note", text: STRINGS.tooLarge });
  if (lines.length === 0) return h("div", { class: "diff-note", text: STRINGS.noChanges });
  const body = h("div", { class: "diff-lines" });
  const rows = document.createDocumentFragment();
  for (const line of lines) {
    rows.append(h("div", { class: `diff-line ${line.kind}` },
      h("span", { class: "sym", text: SYMBOLS[line.kind] }),
      h("span", { class: "txt", text: line.text })));
  }
  body.append(rows);
  return body;
}

export function buildDiffCard(diff: FileDiff, hooks: DiffCardHooks): HTMLElement {
  return h("div", { class: "diff-card" }, diffHead(diff, hooks), diffBody(diff));
}
