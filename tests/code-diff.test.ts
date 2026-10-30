import { expect, test } from "bun:test";
import { codeDiff } from "../src/code-diff";

function reconstruct(before: string, chunks: string[]) {
  let result = before;
  for (const chunk of [...chunks].reverse()) {
    const edit = JSON.parse(chunk).characterEdit;
    expect(result.slice(edit.oldOffset, edit.oldOffset + edit.before.length)).toBe(edit.before);
    result = result.slice(0, edit.oldOffset) + edit.after + result.slice(edit.oldOffset + edit.before.length);
  }
  return result;
}

test("tiny edits in large embedded JSON preserve changed data without copying the whole string", () => {
  const entries = Object.fromEntries(Array.from({ length: 12000 }, (_, index) => [`label${index}`, `Unchanged label ${index}`]));
  const before = `const translations = JSON.parse(${JSON.stringify(JSON.stringify(entries))});`;
  const after = `const translations = JSON.parse(${JSON.stringify(JSON.stringify({ ...entries, label17: "New checkout", label11000: "Save changes" }))});`;
  const chunks = codeDiff("before.js", "after.js", before, after);
  expect(chunks.join("").length).toBeLessThan(10000);
  expect(reconstruct(before, chunks)).toBe(after);
});

test("retains every changed character when character diff exceeds its edit limit", () => {
  const before = "const data='" + "a".repeat(20000) + "';";
  const after = "const data='" + "b".repeat(20000) + "';";
  const chunks = codeDiff("before.js", "after.js", before, after);
  expect(reconstruct(before, chunks)).toBe(after);
  expect(chunks.join("").length).toBeGreaterThan(40000);
});

test("keeps ordinary line patches and returns nothing for identical code", () => {
  const chunks = codeDiff("before.js", "after.js", "const count = 1;\n", "const count = 2;\n");
  expect(JSON.parse(chunks[0]).hunk.lines).toContain("-const count = 1;");
  expect(JSON.parse(chunks[0]).hunk.lines).toContain("+const count = 2;");
  expect(codeDiff("a", "b", "same", "same")).toEqual([]);
});

test("preserves Unicode and multiple insertions and deletions in long lines", () => {
  const before = "const content='" + "unchanged ".repeat(1000) + "😀 old title" + " middle ".repeat(1000) + "obsolete';";
  const after = "const content='" + "unchanged ".repeat(1000) + "🌟 new title" + " middle ".repeat(1000) + "';\nadded();";
  const chunks = codeDiff("before.js", "after.js", before, after);
  expect(reconstruct(before, chunks)).toBe(after);
  expect(chunks.join("").length).toBeLessThan(10000);
});

test("preserves trailing newline changes in long lines", () => {
  const before = "const content='" + "long text ".repeat(1000) + "';";
  const after = before + "\n";
  expect(reconstruct(before, codeDiff("before.js", "after.js", before, after))).toBe(after);
});

test("character offsets refer to the original files across separated hunks", () => {
  const padding = "unchanged();\n".repeat(12);
  const before = padding + "const first='" + "data ".repeat(1000) + "old';\n" + padding + "const second='" + "data ".repeat(1000) + "old';\n";
  const after = before.replaceAll("old'", "new value'");
  const chunks = codeDiff("before.js", "after.js", before, after);
  expect(reconstruct(before, chunks)).toBe(after);
});
