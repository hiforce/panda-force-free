import { expect, test } from "bun:test";
import {
  PublicationCommands,
  type PendingPublicationCommand,
  type PublicationCommand,
} from "../../src/client/documents/publication/commands.js";
import { DocumentApiError } from "../../src/client/documents/api.js";
import { STORAGE_KEYS } from "../../src/client/storage.js";

const project = "11111111-1111-4111-8111-111111111111";
const resource = "22222222-2222-4222-8222-222222222222";
const command = (): PublicationCommand => ({
  kind: "space-configure",
  resource,
  input: { version: 2, theme: "default" },
});
function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("an acknowledged server change with a lost response replays the same operation after reopening", async () => {
  const store = memory(),
    calls: PendingPublicationCommand[] = [],
    receipts = new Map<string, { version: number }>();
  const request = async (value: PendingPublicationCommand) => {
    calls.push(value);
    if (!receipts.has(value.operationId)) receipts.set(value.operationId, { version: 3 });
    if (calls.length === 1) throw new TypeError("Connection interrupted after saving");
    return receipts.get(value.operationId);
  };
  const first = new PublicationCommands("owner", project, request, store);
  await expect(first.execute(command())).rejects.toThrow("Connection interrupted");
  expect(first.pending).toBe(true);
  const reopened = new PublicationCommands("owner", project, request, store);
  expect(reopened.pending).toBe(true);
  expect(await reopened.retry()).toEqual({ version: 3 });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(receipts.size).toBe(1);
  expect(reopened.pending).toBe(false);
  expect(store.values.size).toBe(0);
});

test("concurrent identical submits share one request and callers cannot mutate its frozen payload", async () => {
  const store = memory(),
    calls: PendingPublicationCommand[] = [];
  let release!: () => void;
  const session = new PublicationCommands(
    "owner",
    project,
    async (value) => {
      calls.push(value);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { saved: true };
    },
    store,
  );
  const input = command(),
    a = session.execute(input),
    b = session.execute(command());
  expect(a).toBe(b);
  input.input.theme = "A later edit";
  await Promise.resolve();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.command.input.theme).toBe("default");
  release();
  expect(await a).toEqual({ saved: true });
});

test("an unknown result blocks a different mutation until the recorded operation is reconciled", async () => {
  const store = memory(),
    calls: PendingPublicationCommand[] = [];
  const session = new PublicationCommands(
    "owner",
    project,
    async (value) => {
      calls.push(value);
      throw new DocumentApiError(503, { messageId: "documents.unavailable" });
    },
    store,
  );
  await expect(session.execute(command())).rejects.toBeInstanceOf(DocumentApiError);
  await expect(session.execute({ ...command(), input: { version: 2, theme: "different" } })).rejects.toMatchObject({
    payload: { messageId: "documents.pendingPublicationChange" },
  });
  expect(calls).toHaveLength(1);
  expect(session.pending).toBe(true);
});

test("definitive validation conflicts permit correction, while lost authorization preserves recovery", async () => {
  for (const status of [400, 409, 413, 422, 401, 403, 404, 408, 429]) {
    const store = memory();
    const session = new PublicationCommands(
      "owner",
      project,
      async () => {
        throw new DocumentApiError(status, { messageId: "documents.invalidInput" });
      },
      store,
    );
    await expect(session.execute(command())).rejects.toBeInstanceOf(DocumentApiError);
    expect(session.pending).toBe(![400, 409, 413, 422].includes(status));
  }
});

test("an unstructured gateway rejection keeps the unknown operation recoverable", async () => {
  for (const status of [400, 409, 413, 422]) {
    const session = new PublicationCommands(
      "owner",
      project,
      async () => {
        throw new DocumentApiError(status, {});
      },
      memory(),
    );
    await expect(session.execute(command())).rejects.toBeInstanceOf(DocumentApiError);
    expect(session.pending).toBe(true);
  }
});

test("explicitly rejected source paths can be corrected without forgetting an authorization failure", async () => {
  for (const [status, messageId, pending] of [
    [403, "documents.outsideRoots", false],
    [404, "documents.sourceUnavailable", false],
    [403, "documents.notFound", true],
    [404, "documents.notFound", true],
  ] as const) {
    const session = new PublicationCommands(
      "owner",
      project,
      async () => {
        throw new DocumentApiError(status, { messageId });
      },
      memory(),
    );
    await expect(session.execute(command())).rejects.toBeInstanceOf(DocumentApiError);
    expect(session.pending).toBe(pending);
  }
});

test("a delayed acknowledgement only clears its own project recovery", async () => {
  const store = memory();
  let release!: () => void;
  const first = new PublicationCommands(
    "owner",
    project,
    () =>
      new Promise((resolve) => {
        release = () => resolve({ saved: true });
      }),
    store,
  );
  const a = first.execute(command());
  await Promise.resolve();
  const second = new PublicationCommands(
    "owner",
    resource,
    async () => {
      throw new TypeError("Offline");
    },
    store,
  );
  await expect(second.execute(command())).rejects.toThrow();
  release();
  await a;
  expect(first.pending).toBe(false);
  expect(second.pending).toBe(true);
  expect(store.values.has(STORAGE_KEYS.documentPublicationCommandFor("owner", resource))).toBe(true);
});

test("a reopened view reconciles a command acknowledged by its previous view", async () => {
  const store = memory();
  let release!: () => void;
  const original = new PublicationCommands(
    "owner",
    project,
    () =>
      new Promise((resolve) => {
        release = () => resolve({ saved: true });
      }),
    store,
  );
  const request = original.execute(command());
  await Promise.resolve();
  let repeated = false;
  const reopened = new PublicationCommands(
    "owner",
    project,
    async () => {
      repeated = true;
    },
    store,
  );
  expect(reopened.pending).toBe(true);
  release();
  await request;
  expect(await reopened.retry()).toBeNull();
  expect(reopened.pending).toBe(false);
  expect(repeated).toBe(false);
});

test("recovery stays bound to the identity and project, and malformed saved data is retained", async () => {
  const store = memory();
  const failed = new PublicationCommands(
    "owner",
    project,
    async () => {
      throw new TypeError("Offline");
    },
    store,
  );
  await expect(failed.execute(command())).rejects.toThrow();
  const otherIdentity = new PublicationCommands("another owner", project, async () => null, store);
  const otherProject = new PublicationCommands("owner", resource, async () => null, store);
  expect(otherIdentity.pending).toBe(false);
  expect(otherProject.pending).toBe(false);
  const key = STORAGE_KEYS.documentPublicationCommandFor("owner", project);
  store.values.set(key, "{ broken");
  expect(() => new PublicationCommands("owner", project, async () => null, store)).toThrow();
  expect(store.values.get(key)).toBe("{ broken");
});

test("storage failure prevents an unrecorded request, including commands exceeding the metadata budget", () => {
  const store = memory();
  let requests = 0;
  const session = new PublicationCommands(
    "owner",
    project,
    async () => {
      requests++;
    },
    store,
  );
  store.setItem = () => {
    throw new Error("Storage quota");
  };
  expect(() => session.execute(command())).toThrow();
  expect(requests).toBe(0);
  const bounded = new PublicationCommands(
    "owner",
    project,
    async () => {
      requests++;
    },
    memory(),
  );
  expect(() => bounded.execute({ ...command(), input: { profile: "x".repeat(150001) } })).toThrow();
  expect(requests).toBe(0);
});

test("a failed local acknowledgement can retry the original successful server operation", async () => {
  const store = memory(),
    calls: PendingPublicationCommand[] = [],
    originalRemove = store.removeItem;
  store.removeItem = () => {
    throw new Error("Storage unavailable");
  };
  const session = new PublicationCommands(
    "owner",
    project,
    async (value) => {
      calls.push(value);
      return { saved: true };
    },
    store,
  );
  await expect(session.execute(command())).rejects.toBeInstanceOf(DocumentApiError);
  expect(session.pending).toBe(true);
  store.removeItem = originalRemove;
  expect(await session.retry()).toEqual({ saved: true });
  expect(calls[1]!.operationId).toBe(calls[0]!.operationId);
  expect(session.pending).toBe(false);
});
