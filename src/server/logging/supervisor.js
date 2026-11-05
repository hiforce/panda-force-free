import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { errorCode, errorMessage } from "./../../shared/errors.js";
import { createRotatingLog } from "./rotating-file.js";

export async function runLoggedProcess({
  command,
  cwd,
  env = process.env,
  logging,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  const writer = logging.enabled ? createRotatingLog(logging) : null;
  let fileFailed = false;
  const record = (stream, text) => {
    if (!writer) return;
    try {
      writer.write(`${new Date().toISOString()} [${stream}] ${text}\n`);
      if (fileFailed) stderr.write("[PandaForce] File logging recovered.\n");
      fileFailed = false;
    } catch (error) {
      if (!fileFailed)
        stderr.write(
          `[PandaForce] File logging failed (${errorCode(error) || errorMessage(error)}); console output continues.\n`,
        );
      fileFailed = true;
    }
  };
  const started = `[PandaForce] Service starting; ${writer ? `logs=${logging.directory}; maxFileBytes=${logging.maxFileBytes}; maxFiles=${logging.maxFiles}` : "file logging disabled"}`;
  stdout.write(started + "\n");
  record("stdout", started);
  const child = Bun.spawn(command, { cwd, env, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  let timer;
  const forward = (signal) => {
    record("lifecycle", `Received ${signal}; stopping service`);
    child.kill(signal);
    timer ||= setTimeout(() => child.kill("SIGKILL"), 10000);
    timer.unref();
  };
  const interrupt = () => forward("SIGINT"),
    terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  async function copy(source, destination, stream) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const flush = (end) => {
      while (pending.length) {
        const newline = pending.indexOf("\n");
        let count = newline >= 0 && newline <= 16384 ? newline : Math.min(pending.length, 16384);
        if (newline < 0 && pending.length <= 16384 && !end) break;
        if (count && /[\uD800-\uDBFF]/.test(pending[count - 1])) count--;
        record(stream, pending.slice(0, count).replace(/\r$/, ""));
        pending = pending.slice(count + (newline === count ? 1 : 0));
      }
    };
    for await (const chunk of source) {
      if (!destination.write(chunk)) await once(destination, "drain");
      pending += decoder.write(chunk);
      flush(false);
    }
    pending += decoder.end();
    flush(true);
  }
  try {
    const [, , code] = await Promise.all([
      copy(child.stdout, stdout, "stdout"),
      copy(child.stderr, stderr, "stderr"),
      child.exited,
    ]);
    record("lifecycle", `Service exited with code ${code}`);
    return code;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
