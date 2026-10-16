// Live diff — port of DiffEngine.swift (NotchBuddy/Sources/CoucouKit).
//
// Line diff (LCS) with 3-line context hunks, used for the Edit / MultiEdit /
// Write tool calls the hooks see. Same size guards as macOS: beyond 200 KB or
// 4 000 lines, or when the LCS table would pass a million cells, only the
// +N −M counts are kept and the diff is marked `tooLarge`.
//
// Also home to `toOneLine` (Claude's final message → one line of plain text)
// and the diff step encoding the session board reads (views/board.ts).

export type DiffKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based; -1 for pure adds. */
  origLine: number;
  /** 1-based; -1 for pure removes. */
  newLine: number;
}

export interface DiffHunk {
  origStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  /** Stable identifier assigned by sessionDiffs.append (core/sessionDiffs.ts). */
  id: number;
  path: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  tooLarge: boolean;
  /** True when produced by fromNew (Write tool). */
  isNewFile: boolean;
}

/** FileDiff.maxBytes / maxLines on macOS. */
export const DIFF_MAX_BYTES = 200 * 1024;
export const DIFF_MAX_LINES = 4000;
/** LCS is O(m·n): bail out before the quadratic blowup. */
const DIFF_MAX_CELLS = 1_000_000;
const CONTEXT = 3;

const encoder = new TextEncoder();
const utf8Length = (s: string) => encoder.encode(s).length;

/** Last path component, Windows or POSIX separators. */
export function fileName(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function fromEdit(oldText: string, newText: string, path: string): FileDiff {
  if (utf8Length(oldText) + utf8Length(newText) > DIFF_MAX_BYTES) {
    return countFallback(oldText, newText, path);
  }
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length + newLines.length > DIFF_MAX_LINES) {
    return countFallback(oldText, newText, path);
  }
  if (oldLines.length * newLines.length > DIFF_MAX_CELLS) {
    return countFallback(oldText, newText, path);
  }
  const flat = buildDiffLines(oldLines, newLines);
  let added = 0;
  let removed = 0;
  for (const l of flat) {
    if (l.kind === "added") added++;
    else if (l.kind === "removed") removed++;
  }
  return {
    id: 0, path, added, removed, hunks: buildHunks(flat, CONTEXT), tooLarge: false, isNewFile: false,
  };
}

export function fromNew(content: string, path: string): FileDiff {
  if (utf8Length(content) > DIFF_MAX_BYTES) {
    const lineCount = content.split("\n").length;
    return { id: 0, path, added: lineCount, removed: 0, hunks: [], tooLarge: true, isNewFile: true };
  }
  const lines = splitLines(content);
  if (lines.length > DIFF_MAX_LINES) {
    return { id: 0, path, added: lines.length, removed: 0, hunks: [], tooLarge: true, isNewFile: true };
  }
  const diffLines: DiffLine[] = lines.map((text, i) => ({
    kind: "added", text, origLine: -1, newLine: i + 1,
  }));
  return {
    id: 0,
    path,
    added: diffLines.length,
    removed: 0,
    hunks: diffLines.length ? [{ origStart: 0, newStart: 1, lines: diffLines }] : [],
    tooLarge: false,
    isNewFile: true,
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A diff only counts when it changes something. */
const changes = (d: FileDiff): FileDiff | null => (d.added > 0 || d.removed > 0 ? d : null);

function editDiff(path: string | null, input: Record<string, unknown>): FileDiff | null {
  const oldText = str(input.old_string);
  const newText = str(input.new_string);
  if (oldText == null || newText == null || path == null) return null;
  if (!oldText && !newText) return null;
  return changes(fromEdit(oldText, newText, path));
}

/** Every edit of a MultiEdit, as one diff of the file. */
function multiEditDiff(path: string | null, edits: unknown): FileDiff | null {
  if (path == null || !Array.isArray(edits) || edits.length === 0) return null;
  const total: FileDiff = { id: 0, path, added: 0, removed: 0, hunks: [], tooLarge: false, isNewFile: false };
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") continue;
    const e = edit as Record<string, unknown>;
    const oldText = str(e.old_string);
    const newText = str(e.new_string);
    if (oldText == null || newText == null) continue;
    const d = fromEdit(oldText, newText, path);
    total.added += d.added;
    total.removed += d.removed;
    total.hunks.push(...d.hunks);
    total.tooLarge ||= d.tooLarge;
  }
  return changes(total);
}

function writeDiff(path: string | null, content: string | null): FileDiff | null {
  if (path == null || !content) return null;
  return changes(fromNew(content, path));
}

/**
 * HookServer.buildFileDiff: the diff of one Edit, MultiEdit or Write tool call,
 * or null when the call changes nothing (or is not a file edit at all).
 */
export function buildFileDiff(tool: string, input: Record<string, unknown>): FileDiff | null {
  const path = str(input.file_path);
  if (tool === "Edit") return editDiff(path, input);
  if (tool === "MultiEdit") return multiEditDiff(path, input.edits);
  if (tool === "Write") return writeDiff(path, str(input.content));
  return null;
}

// ── Line splitting ────────────────────────────────────────────────────────────

function splitLines(text: string): string[] {
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline leaves one empty element behind.
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// ── LCS diff ──────────────────────────────────────────────────────────────────

/** dp[i*w + j] = LCS length of oldLines[0..<i] and newLines[0..<j], w = n + 1. */
function lcsTable(oldLines: string[], newLines: string[]): Uint16Array {
  const m = oldLines.length;
  const n = newLines.length;
  const w = n + 1;
  // Lengths stay under DIFF_MAX_LINES, so 16 bits are plenty and the table is half the size.
  const dp = new Uint16Array((m + 1) * w);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i * w + j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[(i - 1) * w + j - 1] + 1
        : Math.max(dp[(i - 1) * w + j], dp[i * w + j - 1]);
    }
  }
  return dp;
}

/** The matching (old, new) line pairs, in order, backtracked from the LCS table. */
function lcsMatches(oldLines: string[], newLines: string[]): [number, number][] {
  const dp = lcsTable(oldLines, newLines);
  const w = newLines.length + 1;
  const matches: [number, number][] = [];
  let i = oldLines.length;
  let j = newLines.length;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return matches.reverse();
}

function buildDiffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  const removed = (from: number, to: number) => {
    for (let k = from; k < to; k++) result.push({ kind: "removed", text: oldLines[k], origLine: k + 1, newLine: -1 });
  };
  const added = (from: number, to: number) => {
    for (let k = from; k < to; k++) result.push({ kind: "added", text: newLines[k], origLine: -1, newLine: k + 1 });
  };
  let prevOld = -1;
  let prevNew = -1;
  for (const [oi, ni] of lcsMatches(oldLines, newLines)) {
    removed(prevOld + 1, oi);
    added(prevNew + 1, ni);
    result.push({ kind: "context", text: oldLines[oi], origLine: oi + 1, newLine: ni + 1 });
    prevOld = oi;
    prevNew = ni;
  }
  removed(prevOld + 1, oldLines.length);
  added(prevNew + 1, newLines.length);
  return result;
}

// ── Hunks ─────────────────────────────────────────────────────────────────────

function buildHunks(lines: DiffLine[], context: number): DiffHunk[] {
  const merged: [number, number][] = [];
  lines.forEach((line, i) => {
    if (line.kind === "context") return;
    const start = Math.max(0, i - context);
    const end = Math.min(lines.length - 1, i + context);
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  });
  return merged.map(([start, end]) => {
    const hunkLines = lines.slice(start, end + 1);
    return {
      origStart: hunkLines.find((l) => l.origLine > 0)?.origLine ?? 1,
      newStart: hunkLines.find((l) => l.newLine > 0)?.newLine ?? 1,
      lines: hunkLines,
    };
  });
}

// ── Count fallback (too large) ────────────────────────────────────────────────

function countFallback(oldText: string, newText: string, path: string): FileDiff {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter((l) => l !== "" && !oldSet.has(l)).length;
  const removed = oldLines.filter((l) => l !== "" && !newSet.has(l)).length;
  return { id: 0, path, added, removed, hunks: [], tooLarge: true, isNewFile: false };
}

// ── toOneLine ─────────────────────────────────────────────────────────────────

const trimWS = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, "");

/** A line that ends a paragraph: blank, a horizontal rule, a table row. */
function breaksParagraph(line: string): boolean {
  const t = trimWS(line);
  const isRule = t.length >= 3 && (/^-+$/.test(t) || /^\*+$/.test(t) || /^_+$/.test(t));
  return t === "" || isRule || t.startsWith("|");
}

function paragraphsOf(text: string): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!breaksParagraph(line)) {
      current.push(line);
      continue;
    }
    if (current.length) paragraphs.push(current);
    current = [];
  }
  if (current.length) paragraphs.push(current);
  return paragraphs;
}

/** One line without its heading `#`, list marker or numbering. */
function plainLine(line: string): string {
  const l = trimWS(line.replace(/^#+/, ""));
  const unlisted = /^[-*•] /.test(l) ? l.slice(2) : l.replace(/^\d+\.\s+/, "");
  return trimWS(unlisted);
}

/**
 * A possibly multi-line Markdown message as one line of plain text: only the
 * first non-empty paragraph (a blank line, a horizontal rule or a table row ends
 * it), without `**`, `__`, backticks, leading `#` or list markers.
 */
export function toOneLine(text: string, maxChars = 200): string {
  for (const para of paragraphsOf(text)) {
    const s = para.join("\n").replaceAll("**", "").replaceAll("__", "").replaceAll("`", "");
    const processed = s.split("\n").map(plainLine).filter(Boolean);
    const collapsed = processed.join(" ").split(/\s+/).filter(Boolean).join(" ");
    if (collapsed) return Array.from(collapsed).slice(0, maxChars).join("");
  }
  return "";
}

// ── Diff steps ────────────────────────────────────────────────────────────────
// A diff shows up in a session's steps as a string the user never sees raw:
// `"<filename>\t<added>:<removed>:<diffId>"` — same format as macOS.

export const DIFF_STEP_MARKER = "";

export interface DiffStep {
  filename: string;
  added: number;
  removed: number;
  diffId: number;
}

export function isDiffStep(step: string): boolean {
  return step.startsWith(DIFF_STEP_MARKER);
}

export function makeDiffStep(filename: string, added: number, removed: number, diffId: number): string {
  return `${DIFF_STEP_MARKER}${filename}\t${added}:${removed}:${diffId}`;
}

export function parseDiffStep(step: string): DiffStep | null {
  if (!isDiffStep(step)) return null;
  const body = step.slice(DIFF_STEP_MARKER.length);
  const tab = body.indexOf("\t");
  if (tab < 0) return null;
  const parts = body.slice(tab + 1).split(":");
  if (parts.length !== 3 || !parts.every((p) => /^-?\d+$/.test(p))) return null;
  const [added, removed, diffId] = parts.map(Number);
  return { filename: body.slice(0, tab), added, removed, diffId };
}

/** The last step that is text, never a diff marker. */
export function lastTextStep(steps: readonly string[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (!isDiffStep(steps[i])) return steps[i];
  }
  return undefined;
}
