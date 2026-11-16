import { mock } from "bun:test";
import { EventEmitter } from "node:events";
import * as native from "node:child_process";
let listeners = -1;
const overflow = process.argv.includes("--overflow");
mock.module("node:child_process", () => ({
  ...native,
  spawn: () => {
    const child = new EventEmitter(),
      stdout = new EventEmitter(),
      stderr = new EventEmitter(),
      stdin = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.pid = 123;
    child.kill = () => false;
    stdin.end = () => {};
    const on = stdout.on;
    stdout.on = function (event, callback) {
      on.call(this, event, callback);
      if (event === "data") {
        this.emit("data", Buffer.from("observed-result"));
        child.exitCode = 0;
        listeners = child.listenerCount("close");
        child.emit("close", 0);
      }
      return this;
    };
    if (overflow) {
      const onErrorData = stderr.on;
      stderr.on = function (event, callback) {
        onErrorData.call(this, event, callback);
        if (event === "data") this.emit("data", Buffer.alloc(20000, 97));
        return this;
      };
    }
    return child;
  },
}));
const { projectGit } = await import("../../src/server/project-content/git/process.ts");
const result = await Promise.race([
  projectGit("/unused", ["rev-parse", "--verify", "refs/heads/content"], { timeoutMs: 50 }).then(
    (bytes) => ({ outcome: "completed", result: bytes.toString() }),
    (error) => ({ outcome: "rejected", code: error.code }),
  ),
  new Promise((resolve) => setTimeout(() => resolve({ outcome: "still-pending-after-200ms" }), 200)),
]);
process.stdout.write(JSON.stringify({ ...result, listenersAtClose: listeners }) + "\n");
if (overflow ? result.code !== "tooLarge" : result.outcome !== "completed") process.exitCode = 1;
