import { spawn } from "node:child_process";
import { BuildError } from "../shared/builds/validation.js";
import { scaffold } from "./scaffold.js";
import { collectArtifact } from "./artifact.js";
import { publishProjectResources } from "./project.js";
import { WorkerInputCollector } from "../shared/builds/worker-input.js";
import { ResourceBuildRequest, type ExecutionInput } from "../shared/builds/resources.js";

/** Native resource frames and historical JSON lines share one bounded stdin owner. */
async function readInput() {
  return await new Promise<ExecutionInput>((resolve, reject) => {
    const collector = new WorkerInputCollector();
    const timeout = setTimeout(() => reject(new BuildError("missingInput")), 30000);
    process.stdin.on("data", (chunk: Buffer) => {
      try {
        if (!collector.push(chunk)) return;
        clearTimeout(timeout);
        process.stdin.pause();
        resolve(collector.result());
      } catch (error) {
        clearTimeout(timeout);
        process.stdin.pause();
        reject(error);
      }
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      reject(new BuildError("missingInput"));
    });
  });
}
try {
  const input = await readInput(),
    command = await scaffold(input, "/work/site");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [command.command, ...command.args], {
      cwd: "/work/site",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.pipe(process.stderr, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new BuildError("engineBuildFailed"))));
  });
  await publishProjectResources(input instanceof ResourceBuildRequest ? input.descriptor.input : input, command.output);
  const artifact = await collectArtifact(command.output);
  process.stdout.write(JSON.stringify(artifact), () => process.exit(0));
} catch (error) {
  process.stderr.write((error instanceof BuildError ? error.code : "engineBuildFailed") + "\n", () => process.exit(1));
}
