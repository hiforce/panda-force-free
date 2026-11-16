import { expect, test } from "bun:test";
import type { ProjectDocumentTree, DocumentTreeMutation } from "../../src/shared/documents/navigation.js";
import { DocumentTreeIndex, type TreeNode } from "../../src/client/documents/authoring/tree-model.js";
import { DocumentTreeSession, type TreeRecovery } from "../../src/client/documents/authoring/tree-session.js";
import type { DocumentTreePort, FrozenTreeCommand } from "../../src/client/documents/authoring/tree-api.js";

const node = (id: string, parentId: string | null, position: number, title = id): TreeNode => ({
  documentId: id,
  parentId,
  position,
  document: {
    id,
    spaceId: "space",
    path: id + ".md",
    title,
    locale: "en",
    revision: 1,
    revisionId: "revision-" + id,
    contentHash: "hash",
    importedHash: null,
    importedRevision: null,
    updatedAt: 1,
  },
});
const tree = (version = 1): ProjectDocumentTree => ({
  projectId: "p",
  version,
  nodes: [
    node("a", null, 0, "Guides"),
    node("b", "a", 0, "Getting started"),
    node("c", "b", 0, "Examples"),
    node("d", null, 1, "Another guide"),
  ],
});
const memory = () => {
  const stored = new Map<string, FrozenTreeCommand>();
  const recovery: TreeRecovery = {
    read: (project) => stored.get(project) || null,
    write: (project, command) => {
      if (command) stored.set(project, structuredClone(command));
      else stored.delete(project);
    },
  };
  return { stored, recovery };
};
const response = (command: FrozenTreeCommand, version = 2): DocumentTreeMutation => ({
  tree: tree(version),
  operation: {
    id: command.id,
    documentId: "a",
    affectedDocumentIds: ["a"],
    treeVersion: version,
    restoredToRoot: false,
  },
});

test("new reads and project changes cancel obsolete IO without surfacing stale failures", async () => {
  const { recovery } = memory(),
    signals: AbortSignal[] = [];
  const api: DocumentTreePort = {
    read: async (project, signal) => {
      if (!signal) throw Error("A read needs a cancellation boundary");
      signals.push(signal);
      if (project === "new") return { projectId: project, version: 1, nodes: [] };
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
    commit: async (command) => response(command),
    definitive: () => true,
  };
  const session = new DocumentTreeSession(api, recovery, () => {});
  session.open("p");
  const first = session.refresh();
  const second = session.refresh();
  expect(signals[0]!.aborted).toBe(true);
  await first;
  expect(session.loading).toBe(true);
  session.open("new");
  expect(signals[1]!.aborted).toBe(true);
  await second;
  await session.refresh();
  expect(session.snapshot.projectId).toBe("new");
  expect(session.loading).toBe(false);
  session.close();
  expect(signals[2]!.aborted).toBe(true);
});

test("tree search preserves logical ancestors, collapse state and duplicate-title identities independently of source paths", () => {
  const index = new DocumentTreeIndex(tree()),
    expanded = new Set(["a"]);
  expect(index.visible(expanded).map((row) => row.node.documentId)).toEqual(["a", "b", "d"]);
  expect(index.visible(expanded, "examples").map((row) => row.node.documentId)).toEqual(["a", "b", "c"]);
  expect(index.path("c")).toBe("Guides / Getting started / Examples");
  expect([...expanded]).toEqual(["a"]);
  expect(index.parents("a").map((row) => row.documentId)).toEqual(["d"]);
  expect(index.canMove("a", { kind: "inside", documentId: "c" })).toBe(false);
  expect(index.canMove("c", { kind: "root" })).toBe(true);
  expect(index.visible(new Set(), "guides").map((row) => row.node.documentId)).toEqual(["a", "b", "c"]);
});
test("destination discovery respects subtree height without a full topology rewrite per candidate", () => {
  const nodes = Array.from({ length: 32 }, (_, i) => node(String(i), i ? String(i - 1) : null, 0));
  nodes.push(node("branch", null, 1), node("leaf", "branch", 0));
  const index = new DocumentTreeIndex({ projectId: "p", version: 1, nodes });
  const parents = index.parents("branch").map((row) => row.documentId);
  expect(parents).toContain("29");
  expect(parents).not.toContain("30");
  expect(parents).not.toContain("31");
  for (const item of nodes)
    expect(parents.includes(item.documentId)).toBe(
      index.canMove("branch", { kind: "inside", documentId: item.documentId }),
    );
});
test("a lost mutation reply survives a new session and replays the identical command before any new write", async () => {
  const { stored, recovery } = memory(),
    calls: FrozenTreeCommand[] = [];
  const api: DocumentTreePort = {
    read: async () => tree(),
    definitive: () => false,
    commit: async (command) => {
      calls.push(structuredClone(command));
      if (calls.length === 1) throw TypeError("Lost reply");
      return response(command);
    },
  };
  const first = new DocumentTreeSession(api, recovery, () => {});
  first.open("p");
  await first.refresh();
  await expect(first.mutate({ kind: "move", documentId: "c", target: { kind: "root" } })).rejects.toThrow("Lost reply");
  expect(first.pending).not.toBeNull();
  expect(first.busy).toBe(false);
  await expect(first.mutate({ kind: "trash", documentId: "a", revision: 1 })).rejects.toThrow("pending");
  const second = new DocumentTreeSession(api, recovery, () => {});
  second.open("p");
  await second.refresh();
  const result = await second.retry();
  expect(result!.tree.version).toBe(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(stored.has("p")).toBe(false);
});
test("late reads cannot overwrite a committed structure or a newer saved document record", async () => {
  const { recovery } = memory();
  let resolveRead!: (value: ProjectDocumentTree) => void;
  const api: DocumentTreePort = {
    read: () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    definitive: () => true,
    commit: async (command) => response(command),
  };
  const session = new DocumentTreeSession(api, recovery, () => {});
  session.open("p");
  const initial = session.refresh();
  resolveRead(tree());
  await initial;
  const stale = session.refresh();
  await session.mutate({ kind: "move", documentId: "c", target: { kind: "root" } });
  resolveRead(tree());
  await stale;
  expect(session.snapshot.version).toBe(2);
  const current = session.refresh();
  session.update({ ...session.snapshot.nodes[0]!.document, title: "Latest title", revision: 3 });
  resolveRead(tree(2));
  await current;
  expect(session.snapshot.nodes[0]!.document.title).toBe("Latest title");
});
test("a callback from a closed session cannot clear a different command created after recovery", async () => {
  const { stored, recovery } = memory();
  let oldReply!: (value: DocumentTreeMutation) => void, newReply!: (value: DocumentTreeMutation) => void;
  let count = 0;
  const api: DocumentTreePort = {
    read: async () => tree(),
    definitive: () => true,
    commit: (command) => {
      count++;
      if (count === 1)
        return new Promise((resolve) => {
          oldReply = resolve;
        });
      if (count === 2) return Promise.resolve(response(command));
      return new Promise((resolve) => {
        newReply = resolve;
      });
    },
  };
  const first = new DocumentTreeSession(api, recovery, () => {});
  first.open("p");
  await first.refresh();
  const old = first.mutate({ kind: "move", documentId: "c", target: { kind: "root" } }),
    oldCommand = structuredClone(first.pending!);
  first.close();
  const second = new DocumentTreeSession(api, recovery, () => {});
  second.open("p");
  await second.refresh();
  await second.retry();
  const current = second.mutate({ kind: "rename", documentId: "a", title: "Renamed", revision: 1 }),
    newCommand = structuredClone(second.pending!);
  oldReply(response(oldCommand));
  expect(await old).toBeNull();
  expect(stored.get("p")!.id).toBe(newCommand.id);
  newReply(response(newCommand, 3));
  await current;
  expect(stored.has("p")).toBe(false);
});

test("a malformed successful response remains recoverable instead of clearing an uncertain write", async () => {
  const { stored, recovery } = memory();
  let wrong = true;
  const api: DocumentTreePort = {
    read: async () => tree(),
    definitive: () => false,
    commit: async (command) => {
      const result = response(command);
      if (wrong) result.operation.id = "unrelated";
      return result;
    },
  };
  const session = new DocumentTreeSession(api, recovery, () => {});
  session.open("p");
  await session.refresh();
  await expect(session.mutate({ kind: "move", documentId: "c", target: { kind: "root" } })).rejects.toThrow("receipt");
  expect(stored.has("p")).toBe(true);
  wrong = false;
  await session.retry();
  expect(stored.has("p")).toBe(false);
});
