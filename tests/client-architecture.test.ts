import { describe, expect, test } from "bun:test";
import { parse } from "acorn";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { STATE_CONTRACTS } from "../src/client/application/state-contracts.js";
const root = resolve(import.meta.dir, "../src/client"),
  folder = resolve(root, "application");
const files = readdirSync(folder)
  .filter((f) => f.endsWith(".js"))
  .map((f) => resolve(folder, f));
const ast = (file) => parse(readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module" });
test("application decisions use branded dialogs instead of browser-native prompts", () => {
  const violations = [];
  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.name.endsWith(".js"))
        walk(ast(file), (node) => {
          if (node.type !== "CallExpression") return;
          const callee = node.callee;
          const name =
            callee.type === "Identifier"
              ? callee.name
              : ["window", "globalThis"].includes(callee.object?.name)
                ? callee.property?.name || callee.property?.value
                : null;
          if (["alert", "confirm", "prompt"].includes(name)) violations.push(relative(root, file) + ": " + name);
        });
    }
  }
  inspect(root);
  expect(violations).toEqual([]);
});
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((n) => walk(n, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}
describe("client module boundaries", () => {
  test("the entry delegates startup and the composition root has no native RPC or DOM event logic", () => {
    const entry = ast(resolve(root, "app.js"));
    expect(entry.body.map((n) => n.type)).toEqual(["ImportDeclaration", "ExpressionStatement"]);
    const violations = [];
    walk(ast(resolve(root, "application.js")), (node) => {
      if (
        node.type === "CallExpression" &&
        ["rpc", "fetch", "querySelector", "addEventListener"].includes(node.callee.name || node.callee.property?.name)
      )
        violations.push(node.callee.name || node.callee.property.name);
    });
    expect(violations).toEqual([]);
  });
  test("feature files stay bounded and do not import the entry or composition root", () => {
    for (const file of files) {
      expect(readFileSync(file, "utf8").split("\n").length).toBeLessThanOrEqual(500);
      for (const node of ast(file).body.filter((n) => n.type === "ImportDeclaration"))
        expect([resolve(root, "app.js"), resolve(root, "application.js")]).not.toContain(
          resolve(dirname(file), node.source.value),
        );
    }
  });
  test("local client imports form an acyclic graph", () => {
    const visited = new Set(),
      active = [];
    function visit(file) {
      if (visited.has(file)) return;
      if (active.includes(file))
        throw Error("Client import cycle: " + [...active, file].map((f) => relative(root, f)).join(" -> "));
      active.push(file);
      for (const n of ast(file).body.filter((n) => n.type === "ImportDeclaration" && n.source.value.startsWith("."))) {
        const target = resolve(dirname(file), n.source.value);
        if (target.startsWith(root) && target.endsWith(".js")) visit(target);
      }
      active.pop();
      visited.add(file);
    }
    visit(resolve(root, "app.js"));
    expect(visited.size).toBeGreaterThan(50);
  });
  test("peers cannot write each other's private state and session replacements use the write boundary", () => {
    const violations = [];
    for (const file of files)
      walk(ast(file), (node) => {
        const target =
          node.type === "AssignmentExpression" ? node.left : node.type === "UpdateExpression" ? node.argument : null;
        if (target?.type !== "MemberExpression") return;
        if (target.object.type === "Identifier" && target.object.name.endsWith("Port"))
          violations.push(relative(root, file) + ": cross-controller write");
        if (
          !file.endsWith("session-state.js") &&
          target.object.name === "state" &&
          ["active", "threads"].includes(target.property.name)
        )
          violations.push(relative(root, file) + ": session replacement");
      });
    expect(violations).toEqual([]);
  });
});

test("every declared peer member exists on the assembled feature interface", () => {
  const interfaces = new Map(),
    factories = [];
  for (const file of files)
    for (const node of ast(file).body) {
      const fn = node.type === "ExportNamedDeclaration" ? node.declaration : null;
      if (fn?.type !== "FunctionDeclaration" || !fn.id.name.startsWith("assemble")) continue;
      const name = fn.id.name.slice("assemble".length),
        key = name[0].toLowerCase() + name.slice(1),
        result = fn.body.body.at(-1);
      expect(result.type).toBe("ReturnStatement");
      interfaces.set(key, new Set(result.argument.properties.map((p) => p.key.name)));
      factories.push({ file, fn });
    }
  const missing = [];
  for (const { file, fn } of factories)
    walk(fn, (node) => {
      if (
        node.type !== "MemberExpression" ||
        node.computed ||
        node.object.type !== "Identifier" ||
        !node.object.name.endsWith("Port")
      )
        return;
      const owner = node.object.name.slice(0, -4);
      if (!interfaces.get(owner)?.has(node.property.name))
        missing.push(relative(root, file) + ": " + node.object.name + "." + node.property.name);
    });
  expect(missing).toEqual([]);
});

test("reciprocal feature dependencies stay within the reviewed UI coordination budget", () => {
  const dependencies = new Map<string, Set<string>>();
  for (const file of files)
    for (const node of ast(file).body) {
      const fn = node.declaration;
      if (fn?.type !== "FunctionDeclaration" || !fn.id.name.startsWith("assemble")) continue;
      const label = fn.id.name.slice(8),
        owner = label[0].toLowerCase() + label.slice(1);
      const peers = new Set<string>();
      dependencies.set(owner, peers);
      walk(fn, (member) => {
        if (
          member.type === "MemberExpression" &&
          member.object.type === "Identifier" &&
          member.object.name.endsWith("Port")
        )
          peers.add(member.object.name.slice(0, -4));
      });
      if (owner !== "environment") expect(STATE_CONTRACTS[owner]).toBeDefined();
    }
  const pairs: string[] = [];
  for (const [owner, peers] of dependencies)
    for (const peer of peers) if (owner < peer && dependencies.get(peer)?.has(owner)) pairs.push(owner + ":" + peer);
  expect(pairs.sort()).toEqual(["panels:settings", "sidebar:workbench"]);
});

test("features receive named services and state access matches explicit grants", () => {
  walk(ast(resolve(root, "application.js")), (node) => {
    if (node.type === "SpreadElement") throw Error("Composition must inject named capabilities");
  });
  for (const file of files)
    for (const node of ast(file).body) {
      const fn = node.declaration;
      if (
        fn?.type !== "FunctionDeclaration" ||
        !fn.id.name.startsWith("assemble") ||
        fn.id.name === "assembleEnvironment"
      )
        continue;
      const label = fn.id.name.slice(8),
        owner = label[0].toLowerCase() + label.slice(1);
      walk(fn, (member) => {
        if (member.type !== "MemberExpression" || member.computed || member.object.name !== "state") return;
        expect(STATE_CONTRACTS[owner].read).toContain(member.property.name);
        if (owner !== "diagnostics" && member.property.name === "stateDomains")
          throw Error("Privileged diagnostic access leaked");
      });
      if (owner !== "diagnostics") expect(fn.params[0].properties.map((p) => p.key.name)).not.toContain("stateDomains");
    }
});
