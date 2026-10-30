import { parse } from "acorn";

interface Node {
  type: string;
  [key: string]: unknown;
}

function children(node: Node): Node[] {
  return Object.values(node).flatMap((value) => {
    const values = Array.isArray(value) ? value : [value];
    return values.filter((entry): entry is Node => entry !== null && typeof entry === "object" && typeof entry.type === "string");
  });
}

function signatures(source: string): string[] {
  if (!/\.\s*u\s*=|\[\s*["']u["']\s*\]\s*=/.test(source)) return [];
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true }) as unknown as Node;
  interface Scope { parent?: Scope; function: boolean; bindings: Map<string, Node[]> }
  const root: Scope = { function: true, bindings: new Map() };
  const scopes = new WeakMap<Node, Scope>();
  const loaders: Node[] = [];
  const assignments: { scope: Scope; name: string; value: Node }[] = [];
  const bound = (node: Node, scope: Scope) => {
    if (node.type === "Identifier") scope.bindings.set(node.name as string, []);
    else if (node.type === "Property") bound(node.value as Node, scope);
    else if (node.type === "AssignmentPattern") bound(node.left as Node, scope);
    else for (const child of children(node)) bound(child, scope);
  };
  const resolve = (scope: Scope, name: string): Scope | undefined =>
    scope.bindings.has(name) ? scope : scope.parent ? resolve(scope.parent, name) : undefined;
  const walk = (node: Node, parent: Scope) => {
    const isFunction = /^(?:FunctionExpression|FunctionDeclaration|ArrowFunctionExpression)$/.test(node.type);
    const scope: Scope = isFunction || node.type === "BlockStatement"
      ? { parent, function: isFunction, bindings: new Map() } : parent;
    scopes.set(node, scope);
    if (node.type === "FunctionDeclaration" && node.id) parent.bindings.set((node.id as Node).name as string, [node]);
    if (node.type === "FunctionExpression" && node.id) bound(node.id as Node, scope);
    if (isFunction) for (const parameter of node.params as Node[]) bound(parameter, scope);
    if (node.type === "VariableDeclaration") {
      let owner = scope;
      while (node.kind === "var" && !owner.function && owner.parent) owner = owner.parent;
      for (const declaration of node.declarations as Node[]) {
        const id = declaration.id as Node;
        bound(id, owner);
        if (id.type === "Identifier" && declaration.init) owner.bindings.set(id.name as string, [declaration.init as Node]);
      }
    }
    if (node.type === "AssignmentExpression") {
      const left = node.left as Node;
      const right = node.right as Node;
      if (left.type === "Identifier") assignments.push({ scope, name: left.name as string, value: right });
      if (left.type === "MemberExpression") {
        const receiver = left.object as Node;
        if (receiver.type === "Identifier") assignments.push({ scope, name: receiver.name as string, value: node });
        const property = left.property as Node;
        if ((!left.computed && property.type === "Identifier" && property.name === "u") ||
          (left.computed && property.type === "Literal" && property.value === "u")) loaders.push(right);
      }
    }
    for (const child of children(node)) walk(child, scope);
  };
  walk(tree, root);
  for (const assignment of assignments) {
    const owner = resolve(assignment.scope, assignment.name) ?? root;
    owner.bindings.set(assignment.name, [...owner.bindings.get(assignment.name) ?? [], assignment.value]);
  }
  const canonical = (node: Node) => JSON.stringify(node, (key, value) =>
    ["start", "end", "loc", "range", "raw"].includes(key) ? undefined : typeof value === "bigint" ? String(value) : value);
  return loaders.flatMap((loader) => {
    const dependencies = new Set<Node>();
    const definitions: Node[] = [loader];
    const include = (definition: Node) => {
      if (dependencies.has(definition)) return;
      dependencies.add(definition);
      visit(definition);
    };
    const visit = (node: Node) => {
      if (node.type === "Identifier") {
        const definitions = resolve(scopes.get(node)!, node.name as string)?.bindings.get(node.name as string) ?? [];
        for (const definition of definitions)
          if (definition.type !== "AssignmentExpression" || (definition.left as Node).type !== "MemberExpression") include(definition);
      }
      if (node.type === "MemberExpression") {
        const object = node.object as Node;
        const key = (member: Node) => member.computed ? (member.property as Node).value : (member.property as Node).name;
        if (object.type === "Identifier") {
          for (const definition of resolve(scopes.get(node)!, object.name as string)?.bindings.get(object.name as string) ?? [])
            if (definition.type === "AssignmentExpression" && (definition.left as Node).type === "MemberExpression" &&
              (key(node) === undefined || key(node) === key(definition.left as Node))) include(definition);
        }
        visit(node.object as Node);
        if (node.computed) visit(node.property as Node);
      } else if (node.type === "Property" && !node.computed) visit(node.value as Node);
      else for (const child of children(node)) visit(child);
    };
    visit(loader);
    definitions.push(...dependencies);
    let javascript = false;
    const inspect = (node: Node) => {
      if (node.type === "Literal" && typeof node.value === "string" && /\.(?:m?js)(?:[?#]|$)/.test(node.value)) javascript = true;
      if (node.type === "TemplateElement" && /\.(?:m?js)(?:[?#]|$)/.test(String((node.value as { cooked: string }).cooked))) javascript = true;
      for (const child of children(node)) inspect(child);
    };
    for (const definition of definitions) inspect(definition);
    return javascript ? [definitions.map(canonical).sort().join("\n")] : [];
  }).sort();
}

export function changedChunkLoader(before: string, after: string): boolean {
  return JSON.stringify(signatures(before)) !== JSON.stringify(signatures(after));
}
