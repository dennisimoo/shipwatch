import { expect, test } from "bun:test";
import { canonicalUrl, pairBundles, type BundleEntry } from "../src/matching";

const entry = (name: string, hash = name): BundleEntry => ({ url: `https://app.example.com/_next/static/chunks/${name}`, hash });
const lines = (name: string, count = 30) => Array.from({ length: count }, (_, index) =>
  `const ${name}Feature${index} = "${name} unique application behavior ${index}";`).join("\n");

test("preserves stable numeric and named chunk identities", () => {
  const before = [entry("90018-aaaaaaaaaaaaaaaa.js"), entry("90019-bbbbbbbbbbbbbbbb.js"), entry("page-cccccccccccccccc.js")];
  const after = [entry("90019-dddddddddddddddd.js"), entry("page-eeeeeeeeeeeeeeee.js"), entry("90018-ffffffffffffffff.js")];
  const result = pairBundles(before, after, (asset) => asset.hash);
  expect(result.ambiguous).toBe(false);
  expect(result.pairs).toEqual([[before[0], after[2]], [before[1], after[0]], [before[2], after[1]]]);
});

test("pairs two renamed anonymous chunks by distinctive shared contents", () => {
  const before = [entry("a0123456789abcde.js"), entry("b0123456789abcde.js")];
  const after = [entry("c0123456789abcde.js"), entry("d0123456789abcde.js")];
  const sources = new Map([[before[0], lines("request")], [before[1], lines("editor")],
    [after[0], lines("editor") + '\nconst progress = "restored";'],
    [after[1], lines("request") + '\nconst progress = "running";']]);
  const result = pairBundles(before, after, (asset) => sources.get(asset)!);
  expect(result.ambiguous).toBe(false);
  expect(result.pairs).toEqual([[before[0], after[1]], [before[1], after[0]]]);
});

test("does not guess anonymous pairing from one filename or common boilerplate", () => {
  const before = [entry("a0123456789abcde.js"), entry("b0123456789abcde.js")];
  const after = [entry("c0123456789abcde.js"), entry("d0123456789abcde.js")];
  const result = pairBundles(before, after, (asset) => lines("shared") + `\nconst unique = "${asset.hash}";`);
  expect(result.ambiguous).toBe(true);
  expect(result.pairs.every(([old, next]) => !old || !next)).toBe(true);
  const unrelated = pairBundles([before[0]], [after[0]], (asset) => lines(asset.hash));
  expect(unrelated.ambiguous).toBe(true);
  expect(unrelated.pairs).toHaveLength(2);
  for (const extension of ["mjs", "css"]) {
    const opaque = pairBundles([entry(`aaaaaaaaaaaaaaaa.${extension}`)], [entry(`bbbbbbbbbbbbbbbb.${extension}`)],
      (asset) => lines(asset.hash));
    expect(opaque.ambiguous).toBe(true);
    expect(opaque.pairs).toHaveLength(2);
  }
});

test("compares adjacent short lines instead of dropping their shared code", () => {
  const before = [entry("a0123456789abcde.js")];
  const after = [entry("b0123456789abcde.js")];
  const library = Array.from({ length: 100 }, (_, index) => `function sdk${index}() {\nreturn ${index};\n}`).join("\n");
  const result = pairBundles(before, after, (asset) => library + `\nconst value = "${asset.hash}";`);
  expect(result.ambiguous).toBe(false);
  expect(result.pairs).toEqual([[before[0], after[0]]]);
});

test("retains long-line evidence when one change affects several adjacent shingles", () => {
  const before = [entry("a0123456789abcde.js")];
  const after = [entry("b0123456789abcde.js")];
  const library = lines("translations", 20).split("\n");
  const result = pairBundles(before, after, (asset) => library.map((line, index) =>
    index === 10 ? `const localizedCopy = "${asset.hash}";` : line).join("\n"));
  expect(result.ambiguous).toBe(false);
  expect(result.pairs).toEqual([[before[0], after[0]]]);
});

test("matches exact URLs before equivalents and respects location/query/kind boundaries", () => {
  const before = [entry("app-aaaaaaaa.js"), entry("other-aaaaaaaa.js")];
  const after = [entry("other-aaaaaaaa.js"), entry("app-bbbbbbbb.js")];
  expect(pairBundles(before, after, () => "same").pairs).toEqual([[before[1], after[0]], [before[0], after[1]]]);
  for (const url of ["https://cdn.example.com/_next/static/chunks/new.js", "https://app.example.com/other/new.js",
    "https://app.example.com/_next/static/chunks/new.js?mode=2", "https://app.example.com/_next/static/chunks/new.css"]) {
    const result = pairBundles([before[0]], [{ url, hash: "changed" }], () => lines("shared"));
    expect(result.pairs).toHaveLength(2);
  }
  expect(canonicalUrl("https://example.com/a.js?mode=2&dpl=dpl_test#chunk")).toBe("https://example.com/a.js?mode=2");
  expect(pairBundles([before[0], before[0]], after, () => "same").duplicateUrls).toBe(true);
  const duplicate = { ...before[0], url: before[0].url + "?dpl=dpl_other", hash: "different" };
  const duplicates = pairBundles([before[0], duplicate], [after[1]], (asset) =>
    lines("shared") + `\nconst unique = "${asset.hash}";`);
  expect(duplicates.duplicateUrls).toBe(true);
  expect(duplicates.ambiguous).toBe(true);
  expect(duplicates.pairs.every(([old, next]) => !old || !next)).toBe(true);
});
