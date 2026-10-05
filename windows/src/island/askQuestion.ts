// AskUserQuestion model — port of AskQuestion.swift. No DOM: parsing the tool
// input and building the `answers` map Claude Code expects back.

export interface AskOption {
  label: string;
  description: string;
}

export interface AskItem {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect: boolean;
}

/** One question's answer: the picked labels, or the text typed under "Other". */
export type AskAnswer = { kind: "labels"; labels: string[] } | { kind: "other"; text: string };

/**
 * The questions, or null when the input is outside what the tool allows
 * (1–4 questions, each with text and 2–4 labelled options). A null makes the
 * island hand the question back to the terminal rather than show half of it.
 */
export function parseQuestions(input: unknown): AskItem[] | null {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return null;
  const items: AskItem[] = [];
  for (const q of raw) {
    if (typeof q !== "object" || q == null) return null;
    const r = q as Record<string, unknown>;
    const question = typeof r.question === "string" ? r.question.trim() : "";
    if (!question) return null;
    if (!Array.isArray(r.options) || r.options.length < 2 || r.options.length > 4) return null;
    const options: AskOption[] = [];
    for (const o of r.options) {
      const label = typeof o?.label === "string" ? o.label.trim() : "";
      if (!label) return null;
      options.push({ label, description: typeof o.description === "string" ? o.description : "" });
    }
    items.push({
      // Kept verbatim: it is the key of the answers map, and must match exactly.
      question: r.question as string,
      header: typeof r.header === "string" ? r.header.slice(0, 12) : "",
      options,
      multiSelect: r.multiSelect === true,
    });
  }
  return items;
}

/**
 * `{"<question>": "<label>"}` for single-select and "Other", `["a", "b"]` for
 * multi-select — the shape Claude Code records in the tool result. Unanswered
 * questions are left out.
 */
export function buildAnswers(
  items: AskItem[],
  answers: (AskAnswer | undefined)[],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  items.forEach((item, i) => {
    const a = answers[i];
    if (!a) return;
    if (a.kind === "other") {
      const text = a.text.trim();
      if (text) out[item.question] = text;
      return;
    }
    if (a.labels.length === 0) return;
    out[item.question] = item.multiSelect ? [...a.labels] : a.labels[0];
  });
  return out;
}
