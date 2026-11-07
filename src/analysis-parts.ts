import { tokenizer } from "acorn";
import { diffArrays } from "diff";
import { AIReplyError } from "./ai";

import type { Reference } from "./api-references";
interface TextEdit {
  before: string; after: string; oldOffset?: number; newOffset?: number;
  [key: string]: unknown;
}
export interface EvidenceChunk {
  fragmented?: boolean; evidenceId?: string; oldFile?: string; newFile?: string;
  sourceDiff?: (string | [string, string])[];
  oldOffset?: number; newOffset?: number;
  characterEdit?: TextEdit; textFragment?: TextEdit;
  hunk?: { lines: string[]; oldStart: number; newStart: number; [key: string]: unknown };
  apiAdded?: Reference; apiRemoved?: Reference;
}

// Keep Unicode code points intact when dividing a source string.
const midpoint = (text: string) => {
  let at = Math.ceil(text.length / 2);
  if (at < text.length && /[\uDC00-\uDFFF]/.test(text[at]) && /[\uD800-\uDBFF]/.test(text[at - 1])) at++;
  return at;
};

/** Align structure for a compact representation; preserve every original character on both sides. */
export function compactEvidence(item: EvidenceChunk): EvidenceChunk {
  const edit = item.characterEdit;
  if (!edit || edit.before.length + edit.after.length < 20000) return item;
  const { before, after } = edit;
  try {
    const tokens = (source: string) => {
      const result = [];
      for (const token of tokenizer(source, { ecmaVersion: "latest" })) {
        if (result.length >= 100000) return null;
        result.push(token);
      }
      return result;
    };
    const oldTokens = tokens(before), newTokens = tokens(after);
    if (!oldTokens || !newTokens) return item;
    const aligned = diffArrays(oldTokens, newTokens, { timeout: 500, maxEditLength: 10000,
      comparator: (a, b) => a.type.label === b.type.label && (a.type.label === "name" ||
        before.slice(a.start, a.end) === after.slice(b.start, b.end)),
    });
    if (!aligned) return item;
    const sourceDiff: (string | [string, string])[] = [];
    const append = (old: string, next: string) => {
      if (!old && !next) return;
      const last = sourceDiff.at(-1);
      if (old === next) {
        if (typeof last === "string") sourceDiff[sourceDiff.length - 1] = last + old;
        else sourceDiff.push(old);
      } else if (Array.isArray(last)) { last[0] += old; last[1] += next; }
      else sourceDiff.push([old, next]);
    };
    let oldIndex = 0, newIndex = 0, oldOffset = 0, newOffset = 0;
    for (const change of aligned) {
      if (change.removed) oldIndex += change.count;
      else if (change.added) newIndex += change.count;
      else for (let index = 0; index < change.count; index++) {
        const a = oldTokens[oldIndex++], b = newTokens[newIndex++];
        append(before.slice(oldOffset, a.start), after.slice(newOffset, b.start));
        append(before.slice(a.start, a.end), after.slice(b.start, b.end));
        oldOffset = a.end; newOffset = b.end;
      }
    }
    append(before.slice(oldOffset), after.slice(newOffset));
    const { characterEdit: _edit, ...files } = item;
    const { before: _before, after: _after, ...context } = edit;
    const compact = { ...files, sourceDiff, oldOffset: edit.oldOffset, newOffset: edit.newOffset, context };
    return JSON.stringify(compact).length < JSON.stringify(item).length ? compact : item;
  } catch { return item; }
}

/** A split is a lossless partition of evidence, never a request to summarize discarded source. */
export function divideEvidence(items: EvidenceChunk[]): [EvidenceChunk[], EvidenceChunk[]] {
  if (items.length > 1) {
    const sizes = items.map((item) => JSON.stringify(item).length);
    const half = sizes.reduce((a, b) => a + b, 0) / 2;
    let cut = 1, size = sizes[0];
    while (cut < items.length - 1 && size < half) size += sizes[cut++];
    return [items.slice(0, cut), items.slice(cut)];
  }
  let item = items[0];
  if (item.sourceDiff) {
    item = { ...item, fragmented: true };
    const segments = item.sourceDiff!;
    if (segments.length > 1) {
      const at = Math.ceil(segments.length / 2), left = segments.slice(0, at), right = segments.slice(at);
      const length = (side: 0 | 1) => left.reduce((sum, segment) => sum + (typeof segment === "string" ? segment : segment[side]).length, 0);
      return [[{ ...item, sourceDiff: left }], [{ ...item, sourceDiff: right,
        oldOffset: (item.oldOffset ?? 0) + length(0), newOffset: (item.newOffset ?? 0) + length(1) }]];
    }
    const segment = segments[0];
    if (typeof segment === "string") {
      const at = midpoint(segment);
      if (!at || at === segment.length) throw new AIReplyError("Indivisible comparison exceeds token budget");
      return [[{ ...item, sourceDiff: [segment.slice(0, at)] }], [{ ...item, sourceDiff: [segment.slice(at)],
        oldOffset: (item.oldOffset ?? 0) + at, newOffset: (item.newOffset ?? 0) + at }]];
    }
    const { sourceDiff: _sourceDiff, ...files } = item;
    return divideEvidence([{ ...files, characterEdit: { before: typeof segment === "string" ? segment : segment[0],
      after: typeof segment === "string" ? segment : segment[1], oldOffset: item.oldOffset, newOffset: item.newOffset } }]);
  }
  if (item.characterEdit || item.textFragment) {
    const field = item.characterEdit ? "characterEdit" : "textFragment";
    const edit = item[field]!;
    const { before, after } = edit;
    if (Math.max(before.length, after.length) <= 1) throw new AIReplyError("Indivisible comparison exceeds token budget");
    const oldCut = midpoint(before), newCut = midpoint(after);
    if (oldCut === before.length && newCut === after.length) throw new AIReplyError("Indivisible comparison exceeds token budget");
    const { preceding, following, oldPreceding, oldFollowing, newPreceding, newFollowing, ...range } = edit;
    const fragment = (start: boolean) => ({ ...item, fragmented: true, [field]: {
      ...range,
      contextOutsideOriginalEdit: edit.contextOutsideOriginalEdit ?? { preceding, following, oldPreceding, oldFollowing, newPreceding, newFollowing }, before: start ? before.slice(0, oldCut) : before.slice(oldCut),
      after: start ? after.slice(0, newCut) : after.slice(newCut),
      oldOffset: (edit.oldOffset ?? 0) + (start ? 0 : oldCut),
      newOffset: (edit.newOffset ?? 0) + (start ? 0 : newCut),
      fragmented: true,
    } });
    return [[fragment(true)], [fragment(false)]];
  }
  if (item.hunk?.lines) {
    const hunk = item.hunk;
    const text = (side: string) => {
      let result = "", included = false;
      for (const line of hunk.lines) {
        if (line.startsWith("\\")) { if (included) result = result.slice(0, -1); continue; }
        included = line.startsWith(" ") || line.startsWith(side);
        if (included) result += line.slice(1) + "\n";
      }
      return result;
    };
    const { hunk: _hunk, ...files } = item;
    return divideEvidence([{ ...files, textFragment: { before: text("-"), after: text("+"),
      oldLineStart: hunk.oldStart, newLineStart: hunk.newStart, fragmented: true } }]);
  }
  // API reference records can be large because they contain many parameter names.
  for (const field of ["queryParams", "bodyParams"] as const) {
    const reference = item.apiAdded ?? item.apiRemoved;
    if (reference && reference[field]?.length > 1) {
      const key = item.apiAdded ? "apiAdded" : "apiRemoved";
      const cut = Math.ceil(reference[field].length / 2);
      return [[{ ...item, fragmented: true, [key]: { ...reference, [field]: reference[field].slice(0, cut), fragmented: true } }],
        [{ ...item, fragmented: true, [key]: { ...reference, [field]: reference[field].slice(cut), fragmented: true } }]];
    }
  }
  throw new AIReplyError("Indivisible comparison exceeds token budget");
}
