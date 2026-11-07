import { parse } from "acorn";

type Node = { type: string; start: number; end: number; [key: string]: unknown };
const children = (node: Node): Node[] => Object.values(node).flatMap((value) =>
  (Array.isArray(value) ? value : [value]).filter((entry): entry is Node =>
    entry !== null && typeof entry === "object" && typeof entry.type === "string"));
const property = (node: Node): string | undefined => {
  const key = (node.property ?? node.key) as Node | undefined;
  return !node.computed && key?.type === "Identifier" ? key.name as string
    : key?.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
};

/** Ignore only known SDK metadata slots, never arbitrary hash strings or business release fields. */
export function normalizeBuildMetadata(source: string): string {
  if (!/NextjsClientStackFrameNormalization|_posthog(?:ReleaseId|ChunkIds)/.test(source)) return source;
  let tree: Node;
  try {
    tree = parse(source, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true }) as unknown as Node;
  } catch { return source; }
  const edits = new Map<number, { end: number; text: string }>();
  const replace = (node: Node, pattern: RegExp, text: string) => {
    if (node.type === "Literal" && typeof node.value === "string" && pattern.test(node.value))
      edits.set(node.start, { end: node.end, text: JSON.stringify(text) });
  };
  const integration = (node: Node): boolean =>
    node.type === "Property" && property(node) === "name" &&
      (node.value as Node)?.value === "NextjsClientStackFrameNormalization" || children(node).some(integration);
  const walk = (node: Node) => {
    if (node.type === "ObjectExpression") {
      const properties = node.properties as Node[];
      if (properties.some((entry) => entry.type === "Property" && ["integrations", "defaultIntegrations"].includes(property(entry) ?? "") && integration(entry.value as Node)))
        for (const entry of properties)
          if (entry.type === "Property" && property(entry) === "release")
            replace(entry.value as Node, /^[a-f0-9]{7,40}$/i, "SENTRY_RELEASE_ID");
    }
    if (node.type === "AssignmentExpression" && node.operator === "=") {
      const left = node.left as Node;
      const right = node.right as Node;
      if (left.type === "MemberExpression") {
        const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
        if (property(left) === "_posthogReleaseId") {
          if (right.type === "LogicalExpression" && right.operator === "||" &&
            source.slice((right.left as Node).start, (right.left as Node).end) === source.slice(left.start, left.end))
            replace(right.right as Node, uuid, "POSTHOG_RELEASE_ID");
          else replace(right, uuid, "POSTHOG_RELEASE_ID");
        }
        const receiver = left.object as Node;
        if (receiver.type === "MemberExpression" && property(receiver) === "_posthogChunkIds")
          replace(right, uuid, "POSTHOG_CHUNK_ID");
      }
    }
    for (const child of children(node)) walk(child);
  };
  try { walk(tree); } catch { return source; }
  for (const [start, edit] of [...edits].sort(([a], [b]) => b - a))
    source = source.slice(0, start) + edit.text + source.slice(edit.end);
  return source;
}
