import { expect, test } from "bun:test";
import { createCommandTool } from "../../src/server/engines/command-tool.js";
test("command tools pass arguments literally and preserve native output", async () => {
  const tool = createCommandTool({ id: "echo", name: "Literal arguments", executable: process.execPath });
  const argument = "$(not-a-shell-command)";
  const result = await tool.execute(["-e", "process.stdout.write(process.argv[1])", argument]);
  expect(result.stdout).toBe(argument);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});
test("cancelled or timed-out tools are never retried", async () => {
  const tool = createCommandTool({ id: "wait", name: "Waiting", executable: process.execPath, timeoutMs: 100 });
  const controller = new AbortController();
  controller.abort();
  expect(() => tool.execute(["-e", "process.exit(0)"], { signal: controller.signal })).toThrow();
  await expect(tool.execute(["-e", "setInterval(() => {}, 1000)"])).rejects.toMatchObject({
    code: "command_tool_interrupted",
    deliveryUncertain: true,
  });
});
