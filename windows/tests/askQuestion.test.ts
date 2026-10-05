// AskUserQuestion parsing and answers. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswers, parseQuestions } from "../src/island/askQuestion.ts";

const opt = (label: string, description = "") => ({ label, description });
const q = (question: string, options = [opt("A"), opt("B")], extra = {}) => ({
  question, header: "Head", options, multiSelect: false, ...extra,
});

test("parses the tool input as Claude Code sends it", () => {
  const items = parseQuestions({ questions: [q("Fruit?", [opt("Apple", "red"), opt("Banana")])] });
  assert.deepEqual(items, [{
    question: "Fruit?", header: "Head", multiSelect: false,
    options: [{ label: "Apple", description: "red" }, { label: "Banana", description: "" }],
  }]);
});

test("rejects input outside the tool's limits", () => {
  assert.equal(parseQuestions(null), null);
  assert.equal(parseQuestions({}), null);
  assert.equal(parseQuestions({ questions: [] }), null);
  assert.equal(parseQuestions({ questions: [1, 2, 3, 4, 5].map((n) => q(`Q${n}?`)) }), null);
  assert.equal(parseQuestions({ questions: [q("  ")] }), null);
  assert.equal(parseQuestions({ questions: [q("One option?", [opt("A")])] }), null);
  assert.equal(parseQuestions({ questions: [q("Five?", ["a", "b", "c", "d", "e"].map((l) => opt(l)))] }), null);
  assert.equal(parseQuestions({ questions: [q("Blank label?", [opt("A"), opt(" ")])] }), null);
});

test("caps the header and defaults what is optional", () => {
  const [item] = parseQuestions({
    questions: [{ question: "Q?", header: "A very long header", options: [{ label: "A" }, { label: "B" }] }],
  })!;
  assert.equal(item.header, "A very long ");
  assert.equal(item.multiSelect, false);
  assert.equal(item.options[0].description, "");
});

test("keeps the question text verbatim, since it keys the answers", () => {
  const [item] = parseQuestions({ questions: [q("  Spaced?  ")] })!;
  assert.equal(item.question, "  Spaced?  ");
});

test("single select answers a string, multi select an array, Other the typed text", () => {
  const items = parseQuestions({
    questions: [
      q("Fruit?"),
      q("Toppings?", [opt("Nuts"), opt("Honey"), opt("Jam")], { multiSelect: true }),
      q("Name?"),
      q("Skipped?"),
    ],
  })!;
  const answers = buildAnswers(items, [
    { kind: "labels", labels: ["B"] },
    { kind: "labels", labels: ["Nuts", "Jam"] },
    { kind: "other", text: "  Mochi  " },
    undefined,
  ]);
  assert.deepEqual(answers, { "Fruit?": "B", "Toppings?": ["Nuts", "Jam"], "Name?": "Mochi" });
});

test("an empty pick or blank Other is not an answer", () => {
  const items = parseQuestions({ questions: [q("A?"), q("B?")] })!;
  assert.deepEqual(buildAnswers(items, [{ kind: "labels", labels: [] }, { kind: "other", text: " " }]), {});
});
