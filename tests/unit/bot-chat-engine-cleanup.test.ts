import { test, expect } from "bun:test";
import type { CodexTransportFactory } from "../../src/server/engines/codex-transport.js";
import { forgetCodexApplicationSession } from "../../src/server/engines/application-tools/codex-forget.js";

test("chat cleanup verifies the owned directory before native deletion and closes only its detached transport", async () => {
  for (const outcome of ["owned", "foreign", "missing", "failed"] as const) {
    const calls: string[] = [];
    let closed = false,
      rejected = false,
      restartCanceled = false;
    const factory: CodexTransportFactory = () => ({
      connected: true,
      fullyStopped: () => closed,
      start() {},
      sendRaw() {},
      cancelRestart() {
        restartCanceled = true;
      },
      rejectPending() {
        rejected = true;
      },
      terminate() {
        closed = true;
      },
      async request(method) {
        calls.push(method);
        if (method === "thread/read") {
          if (outcome === "missing") throw new Error("Thread not found");
          if (outcome === "failed") throw new Error("Connection unavailable");
          return {
            thread: { id: "owned-thread", cwd: outcome === "owned" ? "/isolated/bot-human" : "/shared/project" },
          };
        }
        return {};
      },
    });
    const run = forgetCodexApplicationSession(
      { connection: { mode: "isolated" }, scratchDirectory: "/isolated/bot-human", version: "test" },
      "owned-thread",
      factory,
    );
    if (outcome === "foreign" || outcome === "failed") await expect(run).rejects.toBeInstanceOf(Error);
    else await run;
    expect(calls).toEqual(outcome === "owned" ? ["thread/read", "thread/delete"] : ["thread/read"]);
    expect(closed && rejected && restartCanceled).toBe(true);
  }
});

test("unloaded chat cleanup resolves persisted ownership or confirms absence before completing", async () => {
  for (const result of ["missing", "owned", "foreign", "unavailable"] as const) {
    const calls: string[] = [];
    let stopped = false;
    const factory: CodexTransportFactory = () => ({
      connected: true,
      fullyStopped: () => stopped,
      start() {},
      sendRaw() {},
      cancelRestart() {},
      rejectPending() {},
      terminate() {
        stopped = true;
      },
      async request(method) {
        calls.push(method);
        if (method === "thread/read") throw Error("thread not loaded: old-session");
        if (method === "thread/resume") {
          if (result === "missing") throw Error("no rollout found for thread id old-session");
          if (result === "unavailable") throw Error("Connection unavailable");
          return { thread: { id: "old-session", cwd: result === "owned" ? "/isolated/bot-human" : "/other/project" } };
        }
        return {};
      },
    });
    const work = forgetCodexApplicationSession(
      {
        connection: { mode: "shared", socketPath: "/unused" },
        scratchDirectory: "/isolated/bot-human",
        version: "test",
      },
      "old-session",
      factory,
    );
    if (result === "foreign" || result === "unavailable") await expect(work).rejects.toBeInstanceOf(Error);
    else await work;
    expect(calls).toEqual(
      result === "owned" ? ["thread/read", "thread/resume", "thread/delete"] : ["thread/read", "thread/resume"],
    );
    expect(stopped).toBe(true);
  }
});
