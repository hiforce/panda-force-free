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
