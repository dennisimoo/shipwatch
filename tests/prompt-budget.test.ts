import { expect, test } from "bun:test";
import type { EvidenceChunk } from "../src/analysis-parts";
import { aiFixture } from "./ai-fixture";
process.env.DATABASE_PATH = ":memory:";
const { requestJson, inputTokenLimit, AIPromptTooLargeError } = await import("../src/ai");
const { classifyChange } = await import("../src/analysis");
const { divideEvidence } = await import("../src/analysis-parts");

const count = (request: { messages: { content: unknown }[]; system?: unknown; output_config?: unknown }) =>
  JSON.stringify(request).length;
const patch = (chunks: unknown[]) => chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n";
const result = (classification = "build-only") => ({ classification, kind: "feature", summary: "The website adds a checkout option for its visitors.", details: "The captured code enables checkout; surrounding relationships may require other parts." });

test("all request types reject the provider's oversized token count before a paid call", async () => {
  let paid = 0;
  const client = aiFixture(() => { paid++; return {}; }, () => inputTokenLimit + 1);
  for (const task of ["analysis", "discovery", "summary-rewrite", "analysis-combine"])
    await expect(requestJson(task, "instructions", { text: "short" }, {}, client)).rejects.toBeInstanceOf(AIPromptTooLargeError);
  expect(paid).toBe(0);
});

test("a large paired edit is covered exactly and a late real change survives partitioning", async () => {
  const before = "α😀 before ".repeat(16000), after = "β🌟 after ".repeat(16000);
  const observed: EvidenceChunk[] = [];
  const client = aiFixture((request) => {
    expect(count(request)).toBeLessThanOrEqual(inputTokenLimit + 30); // create adds max_tokens
    const data = JSON.parse(String(request.messages[0].content)) as { evidence: EvidenceChunk[]; unseenChanged: boolean; reasons?: string[]; apiCoverage: unknown };
    if (!data.evidence) return result("application");
    observed.push(...data.evidence);
    return result(data.evidence.some((e) => e.oldFile === "late-feature") ? "application" : "uncertain");
  }, count);
  const chunks = [
    { oldFile: "giant", newFile: "giant", characterEdit: { oldOffset: 10, newOffset: 20, before, after } },
    { oldFile: "late-feature", newFile: "late-feature", characterEdit: { oldOffset: 0, newOffset: 0, before: "enabled=false", after: "enabled=true" } },
  ];
  const classified = await classifyChange({ patch: patch(chunks), unseenChanged: false }, client);
  expect(classified.classification).toBe("application");
  const edits = observed.filter((e) => e.oldFile === "giant").map((e) => e.characterEdit!);
  expect(edits.sort((a, b) => a.oldOffset! - b.oldOffset!).map((e) => e.before).join("")).toBe(before);
  expect(edits.sort((a, b) => a.newOffset! - b.newOffset!).map((e) => e.after).join("")).toBe(after);
  expect(observed.filter((e) => e.oldFile === "late-feature")).toHaveLength(1);
});

test("part-level build-only decisions cannot claim whole-comparison equivalence", async () => {
  const client = aiFixture(() => result(), count);
  const chunks = ["first", "second"].map((name) => ({ oldFile: name, newFile: name,
    characterEdit: { before: "", after: "content ".repeat(8000) } }));
  const classified = await classifyChange({ patch: patch(chunks), unseenChanged: false }, client);
  expect(classified.classification).toBe("uncertain");
});

test("API references and coverage warnings accompany large code evidence", async () => {
  const observed: EvidenceChunk[] = [];
  const client = aiFixture((request) => {
    const data = JSON.parse(String(request.messages[0].content)) as { evidence: EvidenceChunk[]; unseenChanged: boolean; reasons?: string[]; apiCoverage: unknown };
    if (!data.evidence) return result("uncertain");
    expect(data.unseenChanged).toBe(true);
    expect(data.reasons).toEqual(["Missing scripts"]);
    expect(data.apiCoverage).toEqual({ truncated: true, incomplete: true });
    if (!data.evidence) return result("uncertain");
    observed.push(...data.evidence);
    return result("uncertain");
  }, count);
  const refs = { added: [{ url: "https://example.com/report", method: "POST", queryParams: [], bodyParams: ["title"] }],
    removed: [], truncated: true, incomplete: true };
  await classifyChange({ patch: patch([{ oldFile: "coverage", characterEdit: { before: "a".repeat(120000), after: "b".repeat(120000) } }]),
    unseenChanged: true, reasons: ["Missing scripts"], apiChanges: refs }, client);
  expect(observed.filter((e) => e.apiAdded).map((e) => e.apiAdded)).toEqual(refs.added);
});

test("a retry reuses completed parts after a later transport failure", async () => {
  const calls = new Map<string, number>();
  let fail = true;
  const client = aiFixture((request) => {
    const data = JSON.parse(String(request.messages[0].content)) as { evidence: EvidenceChunk[]; unseenChanged: boolean; reasons?: string[]; apiCoverage: unknown };
    if (!data.evidence) return result("application");
    const name = data.evidence[0].oldFile!;
    calls.set(name, (calls.get(name) ?? 0) + 1);
    if (name === "retry-second" && fail) { fail = false; throw new Error("Connection lost"); }
    return result(name === "retry-second" ? "application" : "build-only");
  }, count);
  const input = { patch: patch(["retry-first", "retry-second"].map((name) => ({ oldFile: name,
    characterEdit: { before: "", after: "x".repeat(50000) } }))), unseenChanged: false };
  await expect(classifyChange(input, client)).rejects.toThrow();
  expect((await classifyChange(input, client)).classification).toBe("application");
  expect(calls.get("retry-first")).toBe(1);
  expect(calls.get("retry-second")).toBe(2);
});

test("split line hunks preserve final-newline differences", () => {
  const [a, b] = divideEvidence([{ oldFile: "a", newFile: "b", hunk: { oldStart: 1, newStart: 1,
    lines: ["-before", "\\ No newline at end of file", "+after", "\\ No newline at end of file"] } }]);
  expect(a[0].textFragment!.before + b[0].textFragment!.before).toBe("before");
  expect(a[0].textFragment!.after + b[0].textFragment!.after).toBe("after");
});

test("the token counter sees the identical system, evidence, schema, and model sent for generation", async () => {
  let counted: unknown;
  const client = aiFixture((sent) => {
    expect(sent as unknown).toEqual({ ...(counted as object), max_tokens: 1200 });
    return { ok: true };
  }, (request) => { counted = request; return inputTokenLimit; });
  expect((await requestJson("boundary", "System context", { text: "Evidence" }, { type: "object" }, client)).data)
    .toEqual({ ok: true });
});

test("unusable token counts fail closed without a generation request", async () => {
  let paid = 0;
  for (const bad of [NaN, -1, 1.5]) {
    const client = aiFixture(() => { paid++; return {}; }, () => bad);
    await expect(requestJson("invalid-count", "System", {}, {}, client)).rejects.toThrow("Invalid input token count");
  }
  expect(paid).toBe(0);
});

test("reconciliation can identify a change that needs facts from multiple uncertain parts", async () => {
  const client = aiFixture((request) => {
    const data = JSON.parse(String(request.messages[0].content));
    if (data.evidence) return result("uncertain");
    expect(data.reports.length).toBeGreaterThan(1);
    expect(data.reports.every((report: { details?: string }) => !!report.details)).toBe(true);
    return result("application");
  }, count);
  const chunks = ["joint-first", "joint-second"].map((name) => ({ oldFile: name,
    characterEdit: { before: "", after: "x".repeat(50000) } }));
  expect((await classifyChange({ patch: patch(chunks), unseenChanged: false }, client)).classification).toBe("application");
});

test("fragmented part verdicts cannot override unresolved whole-comparison context", async () => {
  const client = aiFixture((request) => {
    const data = JSON.parse(String(request.messages[0].content));
    return result(data.evidence ? "application" : "uncertain");
  }, count);
  const chunks = ["ambiguous-first", "ambiguous-second"].map((name) => ({ oldFile: name,
    characterEdit: { before: "", after: "y".repeat(120000) } }));
  expect((await classifyChange({ patch: patch(chunks), unseenChanged: false }, client)).classification).toBe("uncertain");
});

test("structural compaction preserves every character, including changed names, literals, and behavior", async () => {
  const { compactEvidence } = await import("../src/analysis-parts");
  const source = (prefix: string, enabled: boolean) => Array.from({ length: 1200 }, (_, i) =>
    `function ${prefix}${i}(${prefix}){ return ${prefix}.value + ${i}; }`).join("\n") + `\nconst enabled=${enabled};`;
  const before = source("alpha", false), after = source("beta", true).replace(".value", ".amount");
  const original = { oldFile: "compact-proof", newFile: "compact-proof", characterEdit: { before, after, oldOffset: 50, newOffset: 75 } };
  const compact = compactEvidence(original);
  expect(compact.sourceDiff).toBeDefined();
  for (const side of [0, 1] as const)
    expect(compact.sourceDiff!.map((segment) => typeof segment === "string" ? segment : segment[side]).join(""))
      .toBe(side === 0 ? before : after);
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(original).length);
  const [left, right] = divideEvidence([compact]);
  for (const side of [0, 1] as const)
    expect([...left[0].sourceDiff!, ...right[0].sourceDiff!].map((segment) => typeof segment === "string" ? segment : segment[side]).join(""))
      .toBe(side === 0 ? before : after);
});

test("a whole paired checkout change survives unrelated incomplete coverage and uncertain reconciliation", async () => {
  const client = aiFixture((request) => {
    const data = JSON.parse(String(request.messages[0].content));
    return result(data.evidence?.some((item: EvidenceChunk) => item.oldFile === "checkout") ? "application" : "uncertain");
  }, count);
  const input = { patch: patch([{ oldFile: "padding", characterEdit: { before: "x".repeat(120000), after: "y".repeat(120000) } },
    { oldFile: "checkout", hunk: { oldStart: 1, newStart: 1, lines: ["-button.disabled=true", "+button.disabled=false"] } }]),
    unseenChanged: true, reasons: ["Unrelated script unavailable"] };
  const classified = await classifyChange(input, client);
  expect(classified.classification).toBe("application");
  expect(classified.summary).toContain("checkout");
});
