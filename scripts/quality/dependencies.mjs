import ts from "typescript";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:[cm]?js|jsx|tsx?|json)$/.test(path) ? [path] : [];
  });

function cycles(files, edges) {
  const graph = new Map(files.map((file) => [file, []]));
  for (const edge of edges) graph.get(edge.from)?.push(edge.to);
  const indices = new Map(),
    low = new Map(),
    active = new Set(),
    stack = [],
    result = [];
  let index = 0;
  function visit(file) {
    indices.set(file, index);
    low.set(file, index++);
    stack.push(file);
    active.add(file);
    for (const next of graph.get(file) || []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(file, Math.min(low.get(file), low.get(next)));
      } else if (active.has(next)) low.set(file, Math.min(low.get(file), indices.get(next)));
    }
    if (low.get(file) !== indices.get(file)) return;
    const component = [];
    let next;
    do {
      next = stack.pop();
      active.delete(next);
      component.push(next);
    } while (next !== file);
    if (component.length > 1 || (graph.get(file) || []).includes(file)) result.push(component.sort());
  }
  for (const file of files) if (!indices.has(file)) visit(file);
  return result;
}

/** Dependency direction applies to both executable imports and type contracts. */
function boundary(from, to, kind, features) {
  const layer = from.split("/")[0],
    target = to.split("/")[0];
  if (layer === "shared" && target !== "shared") return "Shared modules cannot depend on a runtime application";
  if ((layer === "client" && target === "server") || (layer === "server" && target === "client"))
    return "Client and server communicate through contracts, not source imports";
  if (
    layer === "client" &&
    !from.startsWith("client/application/") &&
    from !== "client/application.js" &&
    to.startsWith("client/application/")
  )
    return "Reusable client modules cannot depend on application assembly";
  if (layer === "client" && from !== "client/app.js" && to === "client/application.js")
    return "Only the client entry owns the composition root";
  if (from === "client/conversation-repository.js" && to === "client/conversation-cache.js")
    return "The repository accepts persistence by injection and shares policy without importing a concrete adapter";
  if (
    from.startsWith("client/contracts/") &&
    !to.startsWith("client/contracts/") &&
    !to.startsWith("shared/") &&
    to !== "client/dom-elements.d.ts"
  )
    return "Application contracts cannot import a concrete feature implementation";
  if (from.startsWith("server/protocol/") && target === "server" && !to.startsWith("server/protocol/"))
    return "Protocol codecs cannot depend on authentication, services or adapters";
  if (from.startsWith("server/i18n/") && target === "server" && !to.startsWith("server/i18n/"))
    return "Message contracts cannot depend on HTTP or business services";
  if (/^server\/(?:projects|conversation|review|workspace)\//.test(from) && /^server\/(?:http|bridge)\//.test(to))
    return "Domain and persistence modules cannot depend on transport controllers or native processes";
  if (from.startsWith("server/auth/") && /^server\/(?:bridge|conversation|workspace)\//.test(to))
    return "Authentication cannot depend on engine connections or workspace services";
  if (from === "server/config.ts" && to.startsWith("server/workspace/"))
    return "Configuration must use path utilities rather than workspace services";
  if (from === "server/terminal/worker.js" && target === "server" && to !== "server/terminal/protocol.js")
    return "The terminal worker owns a separate process boundary";
  if (kind !== "type" && features.has(from) && features.has(to))
    return "Feature peers must be injected through named ports";
  if (kind !== "type" && features.has(from) && to === "client/application/composition.js")
    return "Only the composition root installs feature ports";
  return null;
}

export function inspectDependencies(sourceRoot = resolve("src")) {
  const files = sourceFiles(sourceRoot),
    known = new Set(files),
    edges = [],
    missing = [],
    unsupported = [],
    external = [],
    features = new Set();
  const names = new Map(files.map((file) => [file, relative(sourceRoot, file).replaceAll("\\", "/")]));
  const parsed = new Map();
  for (const file of files.filter((file) => !file.endsWith(".json"))) {
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    parsed.set(file, ast);
    if (ast.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text.startsWith("assemble")))
      features.add(names.get(file));
  }
  function add(file, specifier, kind) {
    if (typeof specifier !== "string") {
      unsupported.push(names.get(file));
      return;
    }
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
      external.push({ from: names.get(file), specifier, kind });
      return;
    }
    const aliases = {
      "/app.bundle.js": "client/app.js",
      "/file-preview.bundle.js": "client/file-preview.js",
      "/terminal-runtime.bundle.js": "client/terminal-runtime.js",
      "/i18n.js": "client/i18n.js",
      "/http-client.js": "client/http-client.js",
    };
    const base = specifier.startsWith("/")
      ? aliases[specifier] && resolve(sourceRoot, aliases[specifier])
      : resolve(dirname(file), specifier);
    const target =
      base && [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".d.ts")].find((path) => known.has(path));
    if (!target) {
      // Package metadata is a leaf outside src, not an executable dependency.
      if (base === resolve(sourceRoot, "../package.json") && existsSync(base)) return;
      missing.push({ from: names.get(file), specifier, kind });
      return;
    }
    edges.push({ from: names.get(file), to: names.get(target), kind: target.endsWith(".d.ts") ? "type" : kind });
  }
  for (const [file, ast] of parsed) {
    const declaration = file.endsWith(".d.ts");
    function visit(node, inComment = false) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const bindings = node.importClause?.namedBindings || node.exportClause;
          const specifiers =
            bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) ? bindings.elements : null;
          const onlyTypes =
            declaration ||
            node.isTypeOnly ||
            node.importClause?.isTypeOnly ||
            (!node.importClause?.name && specifiers?.length > 0 && specifiers.every((entry) => entry.isTypeOnly));
          add(file, node.moduleSpecifier.text, onlyTypes ? "type" : "runtime");
        }
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        add(file, node.argument.literal.text, "type");
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && !inComment) {
        const value = node.arguments[0];
        add(file, ts.isStringLiteral(value) ? value.text : null, declaration ? "type" : "dynamic");
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      )
        add(file, node.arguments[0].text, "runtime");
      ts.forEachChild(node, (child) => visit(child, inComment));
      for (const comment of node.jsDoc || []) visit(comment, true);
    }
    visit(ast);
  }
  const unique = [...new Map(edges.map((edge) => [edge.from + ":" + edge.to + ":" + edge.kind, edge])).values()];
  const violations = unique.flatMap((edge) => {
    const reason = boundary(edge.from, edge.to, edge.kind, features);
    return reason ? [{ ...edge, reason }] : [];
  });
  for (const entry of external)
    if (/^(client|shared)\//.test(entry.from) && /^(node|bun):/.test(entry.specifier))
      violations.push({ ...entry, reason: "Portable client and shared contracts cannot import a server runtime" });
  const modules = [...names.values()],
    runtime = unique.filter((edge) => edge.kind !== "type"),
    runtimeCycles = cycles(modules, runtime);
  return {
    modules: modules.length,
    runtimeEdges: runtime.length,
    typeEdges: unique.length - runtime.length,
    runtimeCycles,
    typeCycles: cycles(modules, unique).filter(
      (component) => !runtimeCycles.some((cycle) => JSON.stringify(cycle) === JSON.stringify(component)),
    ),
    violations,
    missing,
    unsupportedDynamicImports: [...new Set(unsupported)],
    edges: unique,
  };
}

if (import.meta.main) {
  const result = inspectDependencies();
  const index = process.argv.indexOf("--report");
  if (index >= 0) writeFileSync(process.argv[index + 1], JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        ...result,
        edges: undefined,
        typeCycles: result.typeCycles.map((component) => ({ modules: component.length })),
      },
      null,
      2,
    ),
  );
  process.exitCode =
    result.runtimeCycles.length ||
    result.typeCycles.length ||
    result.violations.length ||
    result.missing.length ||
    result.unsupportedDynamicImports.length
      ? 1
      : 0;
}
