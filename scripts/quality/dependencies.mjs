import ts from "typescript";
import { inspectBackendStructure } from "./backend-structure.mjs";
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
  if (from.startsWith("server/packages/ownership/") && to === "shared/async-value.ts") return;
  if (from === "server/packages/versions/mysql.ts" && to === "server/packages/mysql-ledger.ts") return;
  if (kind === "type" && from === "server/templates/native/service.ts" && to === "server/packages/ownership/ports.ts")
    return;
  if (
    kind === "type" &&
    from === "server/templates/native/version-policy.ts" &&
    to === "server/packages/versions/contracts.ts"
  )
    return;
  if (
    ["server/templates/storage/native-registry.ts", "server/templates/storage/mysql-native-registry.ts"].includes(
      from,
    ) &&
    to === "server/templates/native/version-policy.ts"
  )
    return;
  // Native persistence adapters may use neutral SQL transactions, immutable
  // schema descriptors and frozen-data import primitives, never feature workflows.
  const nativePersistence =
    from.startsWith("server/") && (from.includes("/storage/") || /\/(?:mysql(?:[-./])|migrate\.ts$)/.test(from));
  if (
    nativePersistence &&
    /^server\/database\/(?:mysql-model\.ts|mysql-session\.ts|consistent-read\.ts|data-migration\.ts|modules\/[a-z0-9-]+\.(?:ts|json))$/.test(
      to,
    )
  )
    return;
  if (from.startsWith("server/search/resources/") && /^server\/search\/(?:storage|providers|integration)\//.test(to))
    return "Resource ownership and cleanup consume physical storage and registry ports without selecting adapters";
  if (layer === "shared" && target !== "shared") return "Shared modules cannot depend on a runtime application";
  if (layer === "cli" && !["cli", "shared"].includes(target))
    return "Standalone CLI and MCP clients depend only on versioned shared contracts, not server or Web runtimes";
  if (
    from.startsWith("server/content-access/") &&
    !/^server\/content-access\/(?:integration|storage)\//.test(from) &&
    target === "server" &&
    (!to.startsWith("server/content-access/") || /^server\/content-access\/(?:integration|storage)\//.test(to))
  )
    return "Content authorization consumes membership ports; only integration selects configuration, project files or grant storage";
  if (
    from.startsWith("server/content-access/storage/") &&
    target === "server" &&
    !to.startsWith("server/content-access/storage/") &&
    to !== "server/content-access/contracts.ts"
  )
    return "Content grant persistence cannot acquire HTTP handlers, content writers or task workflows";
  if (
    from.startsWith("server/cli/auth/") &&
    !from.endsWith("/sqlite.ts") &&
    target === "server" &&
    (!to.startsWith("server/cli/auth/") || to.endsWith("/sqlite.ts"))
  )
    return "CLI authentication consumes a credential port; only the composition root selects persistence";

  if (from.startsWith("shared/skills/") && !/^shared\/(?:skills|packages)\//.test(to))
    return "Skill contracts and composition depend only on their domain and neutral package primitives";
  if (from.startsWith("shared/packages/") && !to.startsWith("shared/packages/"))
    return "Neutral package primitives cannot depend on a feature manifest, installer or execution protocol";
  if (
    from.startsWith("server/creation/") &&
    target === "server" &&
    !to.startsWith("server/creation/") &&
    !from.startsWith("server/creation/integration/")
  )
    return "Creation workflows consume neutral ports; only integration selects document, skill, HTTP or engine adapters";
  if (
    from.startsWith("server/creation/") &&
    to.startsWith("server/creation/storage/") &&
    !/^server\/creation\/(?:storage|integration)\//.test(from)
  )
    return "Creation workflows cannot select concrete task databases or output files";
  if (
    from.startsWith("server/creation/storage/") &&
    to.startsWith("server/creation/") &&
    !to.startsWith("server/creation/storage/") &&
    ![
      "server/creation/contracts.ts",
      "server/creation/ports.ts",
      "server/creation/validation.ts",
      "server/creation/questions/contracts.ts",
    ].includes(to)
  )
    return "Creation persistence cannot depend on application tool dispatch or output orchestration";
  if (
    from.startsWith("server/knowledge/") &&
    !/^server\/knowledge\/(?:integration|storage)\//.test(from) &&
    target === "server" &&
    (!to.startsWith("server/knowledge/") || /^server\/knowledge\/(?:integration|storage)\//.test(to))
  )
    return "Knowledge use cases receive neutral authority and persistence ports; only integration selects adapters";
  if (
    from.startsWith("server/knowledge/storage/") &&
    target === "server" &&
    !to.startsWith("server/knowledge/storage/") &&
    to !== "server/knowledge/tasks/contracts.ts" &&
    to !== "server/knowledge/tasks/access.ts" &&
    to !== "server/knowledge/review/contracts.ts" &&
    to !== "server/knowledge/catalog/contracts.ts" &&
    to !== "server/knowledge/generation/contracts.ts" &&
    to !== "server/knowledge/metadata-ports.ts"
  )
    return "Knowledge metadata persistence cannot acquire workflows, engines or file/Git application authority";
  if (
    from.startsWith("server/engines/application-tools/") &&
    /^server\/(?:creation|knowledge|documents|skills|templates|publishing|delivery)\//.test(to)
  )
    return "Application tool engine adapters cannot acquire task authority or concrete artifact storage";
  if (/^server\/(?:documents|skills|templates|project-content)\//.test(from) && to.startsWith("server/creation/"))
    return "Sources, skills and templates do not depend on creation task workflows";
  if (
    from.startsWith("server/packages/opc/") &&
    !to.startsWith("server/packages/opc/") &&
    !to.startsWith("shared/packages/")
  )
    return "Office package primitives cannot depend on slide editing, template installation or application services";
  if (
    from.startsWith("server/packages/ownership/") &&
    !to.startsWith("server/packages/") &&
    !to.startsWith("shared/packages/")
  )
    return "Source ownership cannot depend on template types, native Office or application authority";
  if (
    from.startsWith("server/packages/versions/") &&
    !to.startsWith("server/packages/versions/") &&
    !to.startsWith("shared/packages/")
  )
    return "Immutable version transactions depend on injected format policies, not concrete template features";
  if (
    from.startsWith("server/slides/templates/") &&
    target === "server" &&
    !to.startsWith("server/slides/") &&
    !to.startsWith("server/packages/")
  )
    return "Native presentation commands compose neutral source and version ports without application or site services";
  if (from.startsWith("server/slides/templates/") && to.startsWith("server/slides/storage/"))
    return "Native presentation commands receive their registry through a port";
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
  if (
    from.startsWith("executor/") &&
    target === "server" &&
    !(from === "executor/main.ts" && to === "server/logging/rotating-file.js")
  )
    return "The executor is a standalone process and cannot import application services";
  if (from.startsWith("document-worker/") && !to.startsWith("document-worker/") && !to.startsWith("shared/builds/"))
    return "Build workers depend only on their protocol and trusted engine scaffolds";
  if (target === "executor" && layer !== "executor")
    return "Applications invoke the build executor over its portable protocol";
  if (target === "document-worker" && layer !== "document-worker")
    return "Only the isolated worker owns engine execution";
  if (from.startsWith("server/protocol/") && target === "server" && !to.startsWith("server/protocol/"))
    return "Protocol codecs cannot depend on authentication, services or adapters";
  if (from.startsWith("server/i18n/") && target === "server" && !to.startsWith("server/i18n/"))
    return "Message contracts cannot depend on HTTP or business services";
  if (from.startsWith("server/documents/") && to.startsWith("server/publishing/"))
    return "Documents own source revisions and cannot depend on publication workflows";
  if (from === "server/documents/editor-port.ts" && target !== "shared")
    return "Document editor ports depend only on portable source and working-copy contracts";
  if (from === "server/documents/editor-routes.ts" && to.startsWith("server/documents/files/"))
    return "Document HTTP handlers consume asynchronous ports rather than selecting file adapters";
  if (from.startsWith("server/project-content/") && target === "server" && !to.startsWith("server/project-content/"))
    return "Project content storage cannot depend on application services or request handling";
  if (
    to.startsWith("server/content-migration/") &&
    target === "server" &&
    !from.startsWith("server/content-migration/")
  )
    return "Offline content migration owns a separate entry point and cannot be an active application source fallback";
  if (
    from.startsWith("server/documents/files/") &&
    ((to.startsWith("server/documents/") &&
      !to.startsWith("server/documents/files/") &&
      /\/(?:[^/]+-)?(?:database|repository|service)\.ts$/.test(to)) ||
      (to.startsWith("server/project-content/migration/") && !to.endsWith("/import-file.ts")))
  )
    return "The active file application cannot acquire legacy body repositories or migration readers";
  if (
    from.startsWith("server/builds/runtime/") &&
    target === "server" &&
    !to.startsWith("server/builds/runtime/") &&
    !["server/builds/errors.ts", "server/builds/authority.ts", "server/builds/executor-port.ts"].includes(to)
  )
    return "Build execution monitoring consumes ports without document, template or concrete storage dependencies";
  if (
    from.startsWith("server/templates/") &&
    target === "server" &&
    !to.startsWith("server/templates/") &&
    !(from.startsWith("server/templates/storage/") && to.startsWith("server/packages/")) &&
    !from.startsWith("server/templates/integration/")
  )
    return "Template management composes native catalog ports without acquiring installers, HTTP handlers or concrete registry storage";
  if (
    from.startsWith("server/templates/") &&
    to.startsWith("server/templates/storage/") &&
    !/^server\/templates\/(?:integration|storage)\//.test(from)
  )
    return "Template services receive storage ports rather than selecting databases or local paths";
  if (
    from.startsWith("server/templates/") &&
    to.startsWith("server/templates/integration/") &&
    !from.startsWith("server/templates/integration/")
  )
    return "Template core cannot import HTTP or feature composition";
  if (
    from.startsWith("server/templates/storage/") &&
    to.startsWith("server/templates/") &&
    !to.startsWith("server/templates/storage/") &&
    ![
      "server/templates/portable/ports.ts",
      "server/templates/portable/errors.ts",
      "server/templates/authoring/ports.ts",
      "server/templates/native/ports.ts",
    ].includes(to)
  )
    return "Template storage consumes contracts and errors without depending on application services";
  if (
    from.startsWith("server/plugins/") &&
    target === "server" &&
    !to.startsWith("server/plugins/") &&
    !(from.startsWith("server/plugins/storage/") && to.startsWith("server/packages/")) &&
    !from.startsWith("server/plugins/integration/")
  )
    return "Plugin approval and storage consume ports; only composition integrates application features";
  if (
    from.startsWith("server/plugins/") &&
    to.startsWith("server/plugins/storage/") &&
    !/^server\/plugins\/(?:integration|storage)\//.test(from)
  )
    return "Plugin services receive storage ports rather than selecting databases or local paths";
  if (
    from.startsWith("server/plugins/storage/") &&
    to.startsWith("server/plugins/") &&
    !to.startsWith("server/plugins/storage/") &&
    !["server/plugins/ports.ts", "server/plugins/errors.ts"].includes(to)
  )
    return "Plugin persistence cannot depend on approval workflows or application assembly";
  if (
    /^server\/(?:documents|builds|publishing)\//.test(from) &&
    to.startsWith("server/plugins/") &&
    !from.includes("/integration/")
  )
    return "Document and content services consume presentation catalog ports without owning plugin installation";
  if (
    from.startsWith("server/connections/") &&
    /^server\/(?:http|auth|documents|publishing|builds|delivery)\//.test(to) &&
    !from.startsWith("server/connections/integration/")
  )
    return "Connections receive identity and operation scopes through ports; only integration owns request authentication";
  if (
    from.startsWith("server/connections/credentials/") &&
    target === "server" &&
    !to.startsWith("server/connections/credentials/")
  )
    return "Credential storage and encryption cannot depend on connection workflows or application services";
  if (/^server\/connections\/(?:oauth|accounts)\//.test(from) && to.startsWith("server/connections/adapters/"))
    return "OAuth and account services consume provider ports; only connection composition selects a platform adapter";
  if (
    from === "server/connections/credentials/cipher.ts" &&
    /^server\/connections\/credentials\/(?:repository|file-key|vault)\.ts$/.test(to)
  )
    return "The cipher accepts a key provider and cannot depend on file storage or persistence";
  if (
    from === "server/connections/credentials/vault.ts" &&
    /^server\/connections\/credentials\/(?:repository|file-key|cipher)\.ts$/.test(to)
  )
    return "The vault consumes credential store and encryption ports rather than concrete adapters";
  if (from.startsWith("server/packages/") && target === "server" && !to.startsWith("server/packages/"))
    return "Neutral content storage cannot depend on package manifests, installers or application services";
  if (
    from.startsWith("server/package-sources/") &&
    !from.endsWith("/feature.ts") &&
    to.startsWith("server/packages/") &&
    !to.startsWith("server/packages/ingestion/")
  )
    return "Source HTTP handlers consume intake use cases without selecting source databases, providers or file owners";
  if (
    from.startsWith("server/packages/") &&
    target === "shared" &&
    !to.startsWith("shared/packages/") &&
    to !== "shared/async-value.ts" &&
    to !== "shared/errors.js"
  )
    return "Neutral content storage shares byte primitives and error utilities without feature contracts";
  if (
    from.startsWith("server/skills/") &&
    target === "server" &&
    !to.startsWith("server/skills/") &&
    !from.startsWith("server/skills/integration/") &&
    !(from.startsWith("server/skills/storage/") && to.startsWith("server/packages/"))
  )
    return "Skill use cases consume ports; only storage uses neutral file IO and composition integrates application features";
  if (
    from.startsWith("server/skills/") &&
    to.startsWith("server/skills/storage/") &&
    !/^server\/skills\/(?:storage|integration)\//.test(from)
  )
    return "Skill services cannot choose concrete databases or filesystem stores";
  if (
    from.startsWith("server/skills/storage/") &&
    to.startsWith("server/skills/") &&
    !to.startsWith("server/skills/storage/") &&
    !["server/skills/ports.ts", "server/skills/errors.ts"].includes(to)
  )
    return "Skill persistence cannot depend on installation or task orchestration";
  if (from.startsWith("server/documents/") && to.startsWith("server/builds/"))
    return "Documents cannot depend on build execution or artifact storage";
  if (
    from.startsWith("server/builds/") &&
    to.startsWith("server/documents/") &&
    !from.startsWith("server/builds/integration/")
  )
    return "Builds consume immutable document snapshots through a source port";
  if (
    from.startsWith("server/builds/") &&
    to.startsWith("server/builds/adapters/") &&
    !from.startsWith("server/builds/integration/") &&
    !from.startsWith("server/builds/adapters/")
  )
    return "Build services receive an executor port; composition installs deployment adapters";
  if (
    from.startsWith("server/publishing/content/") &&
    target === "server" &&
    !to.startsWith("server/publishing/content/")
  )
    return "Portable content transforms cannot depend on platform adapters, storage or transport";
  if (
    from.startsWith("server/editorial/") &&
    target === "server" &&
    !to.startsWith("server/editorial/") &&
    !from.startsWith("server/editorial/integration/")
  )
    return "Editorial review consumes source and processor ports; only integration knows document storage or HTTP";
  if (from.startsWith("server/documents/") && to.startsWith("server/editorial/"))
    return "Document storage cannot depend on editorial workflows";
  if (from.startsWith("client/documents/") && to.startsWith("client/editorial/"))
    return "Document workspaces invoke editorial review through an injected action port";
  if (
    from.startsWith("server/publishing/") &&
    to.startsWith("server/documents/") &&
    !from.startsWith("server/publishing/integration/")
  )
    return "Publishing consumes documents through its source port and integration bridge";
  if (
    from.startsWith("server/publishing/") &&
    to.startsWith("server/publishing/adapters/") &&
    !/^server\/publishing\/(?:adapters|integration)\//.test(from)
  )
    return "Publication services receive adapters through ports; only composition installs them";
  if (
    from.startsWith("server/publishing/") &&
    /^server\/(?:http|auth)\//.test(to) &&
    !from.startsWith("server/publishing/integration/")
  )
    return "Publication domain operations cannot depend on request routing or authentication";
  if (from.startsWith("client/documents/") && to.startsWith("client/publishing/"))
    return "Document editors invoke publishing through an injected action port";
  if (/^server\/(?:documents|builds|publishing)\//.test(from) && to.startsWith("server/delivery/"))
    return "Sources and content transforms cannot depend on delivery workflows";
  if (
    from.startsWith("server/delivery/storage/") &&
    !to.startsWith("server/delivery/storage/") &&
    ![
      "server/delivery/errors.ts",
      "server/delivery/digest.ts",
      "shared/delivery/workflow.ts",
      "shared/delivery/recovery.ts",
      "shared/storage/read-queries.ts",
    ].includes(to)
  )
    return "Publication storage cannot depend on workflows, platform content or adapters";
  if (
    from.startsWith("server/delivery/") &&
    target === "server" &&
    !to.startsWith("server/delivery/") &&
    !from.startsWith("server/delivery/integration/")
  )
    return "Delivery consumes authorized sources and connections through ports";
  if (
    from.startsWith("server/delivery/") &&
    to.startsWith("server/delivery/adapters/") &&
    !/^server\/delivery\/(?:integration|adapters)\//.test(from)
  )
    return "Only delivery composition selects a concrete publication adapter";
  if (/^client\/(?:documents|builds)\//.test(from) && to.startsWith("client/delivery/"))
    return "Document and build views invoke delivery through an injected action port";
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
    deploymentImports = [],
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
      "/writing-skill.bundle.js": "client/templates/authoring-runtime.ts",
      "/writing-skill.bundle.js?retry=1": "client/templates/authoring-runtime.ts",
      "/settings-pages.bundle.js": "client/settings-pages/runtime.ts",
      "/settings-pages.bundle.js?retry=1": "client/settings-pages/runtime.ts",
      "/knowledge.bundle.js": "client/knowledge/runtime.ts",
      "/knowledge.bundle.js?retry=1": "client/knowledge/runtime.ts",
      "/content-workspace.bundle.js": "client/creative/workspaces-runtime.ts",
      "/content-workspace.bundle.js?retry=1": "client/creative/workspaces-runtime.ts",
      "/creative-assets.bundle.js": "client/creative/assets-panel.ts",
      "/creative-assets.bundle.js?retry=1": "client/creative/assets-panel.ts",
      "/template-details.bundle.js": "client/templates/details-runtime.ts",
      "/template-details.bundle.js?retry=1": "client/templates/details-runtime.ts",
      "/template-settings.bundle.js": "client/templates/settings-runtime.ts",
      "/template-settings.bundle.js?retry=1": "client/templates/settings-runtime.ts",
      "/gadget-document.bundle.js": "client/gadget/document-runtime.ts",
      "/gadget-document.bundle.js?retry=1": "client/gadget/document-runtime.ts",
      "/document-creation.bundle.js": "client/creation/controller.ts",
      "/document-creation.bundle.js?retry=1": "client/creation/controller.ts",
      "/document-code-runtime.bundle.js": "client/documents/code-block/reader-runtime.ts",
      "/document-code-runtime.bundle.js?retry=1": "client/documents/code-block/reader-runtime.ts",
      "/document-rich-runtime.bundle.js": "client/documents/rich-runtime.ts",
      "/document-rich-runtime.bundle.js?retry=1": "client/documents/rich-runtime.ts",
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
        // One explicit host extension boundary is deployment-owned, not a statically resolvable application edge.
        // Keep the exact call shape narrow; computed imports anywhere else still fail the source gate.
        if (
          names.get(file) === "server/gadget/module-loader.ts" &&
          ts.isPropertyAccessExpression(value) &&
          value.name.text === "href" &&
          ts.isCallExpression(value.expression) &&
          ts.isIdentifier(value.expression.expression) &&
          value.expression.expression.text === "pathToFileURL" &&
          value.expression.arguments.length === 1 &&
          ts.isIdentifier(value.expression.arguments[0]) &&
          value.expression.arguments[0].text === "path"
        )
          deploymentImports.push({ from: names.get(file), policy: "administrator-configured-absolute-file" });
        else add(file, ts.isStringLiteral(value) ? value.text : null, declaration ? "type" : "dynamic");
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
  for (const entry of external) {
    if (
      /^server\/knowledge\/(?:tasks|review)\//.test(entry.from) &&
      /^(?:bun:sqlite|node:(?:fs(?:\/.*)?|http|https|net|child_process|path))$/.test(entry.specifier)
    )
      violations.push({
        ...entry,
        reason: "Knowledge workflows receive IO ports instead of selecting storage or transport",
      });
    if (/^(client|shared)\//.test(entry.from) && /^(node|bun):/.test(entry.specifier))
      violations.push({ ...entry, reason: "Portable client and shared contracts cannot import a server runtime" });
    if (
      entry.specifier === "bun:sqlite" &&
      (entry.from.startsWith("server/documents/files/") ||
        (entry.from.startsWith("server/project-content/") &&
          !entry.from.startsWith("server/project-content/migration/")))
    )
      violations.push({ ...entry, reason: "Only the explicit legacy importer may read SQLite document bodies" });
  }
  const modules = [...names.values()],
    runtime = unique.filter((edge) => edge.kind !== "type"),
    runtimeCycles = cycles(modules, runtime);
  return {
    structure: inspectBackendStructure(sourceRoot, files),
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
    deploymentImports,
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
        structure: { classes: result.structure.classes.length, violations: result.structure.violations },
        typeCycles: result.typeCycles.map((component) => ({ modules: component.length })),
      },
      null,
      2,
    ),
  );
  process.exitCode =
    result.structure.violations.length ||
    result.runtimeCycles.length ||
    result.typeCycles.length ||
    result.violations.length ||
    result.missing.length ||
    result.unsupportedDynamicImports.length
      ? 1
      : 0;
}
