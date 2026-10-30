import { diffWordsWithSpace, structuredPatch } from "diff";

export function codeDiff(oldFile: string, newFile: string, before: string, after: string): string[] {
  if (before === after) return [];
  const options = { timeout: 100, maxEditLength: 10000 };
  const patch = structuredPatch(oldFile, newFile, before, after, "before", "after", { context: 3, ...options });
  if (patch) {
    const chunks: string[] = [];
    let oldOffset = 0;
    let newOffset = 0;
    let oldLine = 1;
    let newLine = 1;
    for (const hunk of patch.hunks) {
      if (!hunk.lines.some((line) => /^[+-]/.test(line) && line.length > 2000)) {
        chunks.push(JSON.stringify({ oldFile, newFile,
          hunk: { ...hunk, lines: hunk.lines.map((line) => line.startsWith(" ") && line.length > 2000
            ? ` [unchanged context omitted: ${line.length - 1} characters]` : line) },
        }) + "\n");
        continue;
      }
      while (oldLine < hunk.oldStart) { oldOffset = before.indexOf("\n", oldOffset) + 1; oldLine++; }
      while (newLine < hunk.newStart) { newOffset = after.indexOf("\n", newOffset) + 1; newLine++; }
      const lineSlice = (source: string, offset: number, count: number) => {
        let end = offset;
        for (let line = 0; line < count; line++) {
          const newline = source.indexOf("\n", end);
          end = newline < 0 ? source.length : newline + 1;
        }
        return source.slice(offset, end);
      };
      const oldText = lineSlice(before, oldOffset, hunk.oldLines);
      const newText = lineSlice(after, newOffset, hunk.newLines);
      chunks.push(...characterEdits(oldFile, newFile, oldText, newText, oldOffset, newOffset));
    }
    return chunks;
  }
  return characterEdits(oldFile, newFile, before, after);
}

function characterEdits(oldFile: string, newFile: string, before: string, after: string, oldBase = 0, newBase = 0): string[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const oldRegion = before.slice(prefix, oldEnd);
  const newRegion = after.slice(prefix, newEnd);
  const changes = diffWordsWithSpace(oldRegion, newRegion, { timeout: 100, maxEditLength: 10000 }) ?? [
    { value: oldRegion, removed: true }, { value: newRegion, added: true },
  ];
  const chunks: string[] = [];
  let oldOffset = prefix;
  let newOffset = prefix;
  for (let index = 0; index < changes.length;) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      oldOffset += change.value.length;
      newOffset += change.value.length;
      index++;
      continue;
    }
    let removed = "";
    let added = "";
    while (index < changes.length && (changes[index].added || changes[index].removed)) {
      const changed = changes[index++];
      if (changed.removed) removed += changed.value;
      else added += changed.value;
    }
    chunks.push(JSON.stringify({ oldFile, newFile, characterEdit: {
      oldOffset: oldBase + oldOffset, newOffset: newBase + newOffset, before: removed, after: added,
      oldPreceding: before.slice(Math.max(0, oldOffset - 160), oldOffset),
      oldFollowing: before.slice(oldOffset + removed.length, oldOffset + removed.length + 160),
      newPreceding: after.slice(Math.max(0, newOffset - 160), newOffset),
      newFollowing: after.slice(newOffset + added.length, newOffset + added.length + 160),
    } }) + "\n");
    oldOffset += removed.length;
    newOffset += added.length;
  }
  return chunks;
}
