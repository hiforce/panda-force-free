import { isModuleNetworkError } from "../../src/client/documents/module-network-error.js";
import { expect, test } from "bun:test";
import { DocumentRuntimeLoader } from "../../src/client/documents/runtime-loader.js";

test("route warmup transfers once without evaluating, and concurrent edits share one evaluated module", async () => {
  const calls: string[] = [],
    value = { ready: true };
  const loader = new DocumentRuntimeLoader({
    prime: async (entry) => {
      calls.push("prime" + entry);
    },
    evaluate: async (entry) => {
      calls.push("evaluate" + entry);
      return value;
    },
  });
  await Promise.all([loader.warm(), loader.warm()]);
  expect(calls).toEqual(["prime0"]);
  const first = loader.load(),
    second = loader.load();
  expect(first).toBe(second);
  expect(await first).toBe(value);
  expect(await loader.load()).toBe(value);
  expect(calls).toEqual(["prime0", "evaluate0"]);
});

test("a failed unexecuted transfer can select one distinct retry entry and then cache its success", async () => {
  const calls: string[] = [];
  const loader = new DocumentRuntimeLoader({
    prime: async (entry) => {
      calls.push("prime" + entry);
      if (!entry) throw Error("network");
    },
    evaluate: async (entry) => {
      calls.push("evaluate" + entry);
      return entry;
    },
  });
  await expect(loader.load()).rejects.toMatchObject({ phase: "transfer", retryable: true });
  expect(await loader.load()).toBe(1);
  expect(await loader.load()).toBe(1);
  expect(calls).toEqual(["prime0", "prime1", "evaluate1"]);
});

test("repeated transfer failures remain recoverable after the network returns without evaluating failed downloads", async () => {
  const calls: number[] = [];
  let evaluations = 0,
    available = false;
  const loader = new DocumentRuntimeLoader({
    prime: (entry) => {
      calls.push(entry);
      if (!available) throw Error("network");
      return Promise.resolve();
    },
    evaluate: async () => {
      evaluations++;
      return true;
    },
  });
  await expect(loader.load()).rejects.toMatchObject({ phase: "transfer", retryable: true });
  await expect(loader.load()).rejects.toMatchObject({ phase: "transfer", retryable: true });
  await expect(loader.load()).rejects.toMatchObject({ phase: "transfer", retryable: true });
  expect(calls).toEqual([0, 1, 1]);
  expect(evaluations).toBe(0);
  available = true;
  expect(await loader.load()).toBe(true);
  expect(await loader.load()).toBe(true);
  expect(calls).toEqual([0, 1, 1, 1]);
  expect(evaluations).toBe(1);
});

test("speculative warmup failures cannot consume future editing opportunities", async () => {
  let available = false,
    evaluations = 0;
  const loader = new DocumentRuntimeLoader({
    prime: async () => {
      if (!available) throw Error("offline");
    },
    evaluate: async () => ++evaluations,
  });
  await expect(loader.warm()).rejects.toMatchObject({ phase: "transfer", retryable: true });
  await expect(loader.warm()).rejects.toMatchObject({ phase: "transfer", retryable: true });
  available = true;
  const first = loader.load();
  expect(loader.load()).toBe(first);
  expect(await first).toBe(1);
  expect(evaluations).toBe(1);
});

test("initialization failures never reexecute a partially evaluated module or change its URL", async () => {
  const calls: string[] = [];
  const loader = new DocumentRuntimeLoader({
    prime: async (entry) => {
      calls.push("prime" + entry);
    },
    evaluate: async (entry) => {
      calls.push("evaluate" + entry);
      throw Error("side effect already occurred");
    },
  });
  await expect(loader.load()).rejects.toMatchObject({ phase: "initialization", retryable: false });
  await expect(loader.load()).rejects.toMatchObject({ phase: "initialization", retryable: false });
  expect(calls).toEqual(["prime0", "evaluate0"]);
});

test("slow initialization becomes recoverable and retries observe the same module without reevaluation", async () => {
  const calls: string[] = [];
  let resolve!: (value: string) => void;
  const evaluation = new Promise<string>((done) => {
    resolve = done;
  });
  const loader = new DocumentRuntimeLoader({
    prime: async (entry) => {
      calls.push("prime" + entry);
    },
    evaluate: async (entry) => {
      calls.push("evaluate" + entry);
      return evaluation;
    },
    evaluationTimeoutMs: 10,
  });
  await expect(loader.load()).rejects.toMatchObject({ phase: "initialization", retryable: true });
  await expect(loader.load()).rejects.toMatchObject({ phase: "initialization", retryable: true });
  resolve("ready");
  expect(await loader.load()).toBe("ready");
  expect(await loader.load()).toBe("ready");
  expect(calls).toEqual(["prime0", "evaluate0"]);
});

test("an initialization failure after a timeout remains fatal and never starts another module", async () => {
  let reject!: (error: Error) => void,
    evaluations = 0;
  const evaluation = new Promise<string>((_, fail) => {
    reject = fail;
  });
  const loader = new DocumentRuntimeLoader({
    prime: async () => {},
    evaluate: async () => {
      evaluations++;
      return evaluation;
    },
    evaluationTimeoutMs: 10,
  });
  await expect(loader.load()).rejects.toMatchObject({ retryable: true });
  reject(Error("partial initialization failed"));
  await expect(loader.load()).rejects.toMatchObject({ phase: "initialization", retryable: false });
  await expect(loader.load()).rejects.toMatchObject({ retryable: false });
  expect(evaluations).toBe(1);
});

test("native module fetch failures after preparation can retry one fresh URL without repeating initialized code", async () => {
  const calls: string[] = [];
  const loader = new DocumentRuntimeLoader({
    prime: async (entry) => {
      calls.push("prime" + entry);
    },
    evaluate: async (entry) => {
      calls.push("evaluate" + entry);
      if (!entry) throw new TypeError("Failed to fetch dynamically imported module: /document-rich-runtime.bundle.js");
      return "ready";
    },
    isTransferFailure: isModuleNetworkError,
  });
  await expect(loader.load()).rejects.toMatchObject({ phase: "transfer", retryable: true });
  expect(await loader.load()).toBe("ready");
  expect(await loader.load()).toBe("ready");
  expect(calls).toEqual(["prime0", "evaluate0", "prime1", "evaluate1"]);
});
test("native module retry is bounded and unrelated TypeError initialization is never executed twice", async () => {
  for (const message of ["Importing a module script failed.", "Cannot read properties of undefined"]) {
    let count = 0;
    const loader = new DocumentRuntimeLoader({
      prime: async () => {},
      evaluate: async () => {
        count++;
        throw new TypeError(message);
      },
      isTransferFailure: isModuleNetworkError,
    });
    await expect(loader.load()).rejects.toMatchObject({ retryable: message.startsWith("Importing") });
    await expect(loader.load()).rejects.toMatchObject({ retryable: false });
    await expect(loader.load()).rejects.toMatchObject({ retryable: false });
    expect(count).toBe(message.startsWith("Importing") ? 2 : 1);
  }
});
