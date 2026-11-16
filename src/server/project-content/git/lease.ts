import { ProjectGitError, startProjectGit } from "./process.js";

export interface ProjectGitLease {
  readonly signal: AbortSignal;
  readonly processId: number;
  assertHeld(): void;
}

/** A prepared coordination-ref transaction owns exclusion until its callback and release both finish. */
export async function withProjectGitLease<T>(
  directory: string,
  expected: string,
  work: (lease: ProjectGitLease) => Promise<T>,
  options: { prepareTimeoutMs?: number; releaseTimeoutMs?: number; waitForLockMs?: number } = {},
): Promise<T> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected))
    throw new ProjectGitError("failed", null, "Invalid coordination object");
  const prepareTimeout = options.prepareTimeoutMs ?? 30000,
    releaseTimeout = options.releaseTimeoutMs ?? 5000,
    waitForLockMs = options.waitForLockMs ?? 0;
  if ([prepareTimeout, releaseTimeout].some((value) => !Number.isSafeInteger(value) || value < 1 || value > 300000))
    throw new ProjectGitError("failed", null, "Invalid coordination budget");
  if (!Number.isSafeInteger(waitForLockMs) || waitForLockMs < 0 || waitForLockMs >= prepareTimeout)
    throw new ProjectGitError("failed", null, "Invalid coordination wait budget");
  const child = startProjectGit(directory, [
      "-c",
      "core.filesRefLockTimeout=" + waitForLockMs,
      "update-ref",
      "--no-deref",
      "--stdin",
    ]),
    controller = new AbortController();
  let output = "",
    diagnostic = "",
    prepared = false,
    rejectReady: (error: unknown) => void = () => {},
    resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const done = new Promise<number | null>((resolve) => {
    child.once("error", (cause) => {
      controller.abort();
      rejectReady(new ProjectGitError("failed", null, cause.message));
      resolve(null);
    });
    child.once("close", (status) => {
      controller.abort();
      if (!prepared) rejectReady(new ProjectGitError("failed", status, diagnostic));
      resolve(status);
    });
  });
  child.stdin.on("error", () => {
    // Process completion reports a rejected or lost ref transaction.
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    output += text;
    if (output.length > 16384) {
      rejectReady(new ProjectGitError("tooLarge", null, "Unexpected transaction output"));
      child.kill("SIGTERM");
    } else if (!prepared && output.includes("prepare: ok\n")) {
      prepared = true;
      resolveReady();
    }
  });
  child.stderr.on("data", (text: string) => {
    diagnostic += text;
    if (diagnostic.length > 16384) {
      diagnostic = diagnostic.slice(0, 16384);
      rejectReady(new ProjectGitError("tooLarge", null, diagnostic));
      child.kill("SIGTERM");
    }
  });
  const release = async () => {
    if (!controller.signal.aborted) child.stdin.end("abort\n");
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        done,
        new Promise<null>((resolve) => {
          deadline = setTimeout(() => {
            controller.abort();
            child.kill("SIGKILL");
            resolve(null);
          }, releaseTimeout);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  };
  const timer = setTimeout(() => {
    rejectReady(new ProjectGitError("timeout", null, "Coordination transaction did not prepare"));
    child.kill("SIGTERM");
  }, prepareTimeout);
  child.stdin.write("start\nverify refs/panda/coordination " + expected + "\nprepare\n");
  try {
    await ready;
  } catch (error) {
    child.kill("SIGTERM");
    await release();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const lease: ProjectGitLease = Object.freeze({
    signal: controller.signal,
    processId: child.pid!,
    assertHeld() {
      if (controller.signal.aborted || child.exitCode !== null || child.signalCode !== null)
        throw new ProjectGitError("lockLost", child.exitCode, "Project coordination process is no longer held");
    },
  });
  let outcome: { value: T } | { error: unknown };
  try {
    lease.assertHeld();
    const value = await work(lease);
    lease.assertHeld();
    outcome = { value };
  } catch (error) {
    outcome = { error };
  }
  const status = await release();
  if (status !== 0) {
    const lost = new ProjectGitError("lockLost", status, diagnostic);
    if ("error" in outcome) throw new AggregateError([outcome.error, lost], "Project lock completion failed");
    throw lost;
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
