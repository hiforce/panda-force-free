import { PROJECT_CONTENT_LIMITS } from "../limits.js";
import { spawn } from "node:child_process";

export interface ContentAuthor {
  name: string;
  email: string;
}

export class ProjectGitError extends Error {
  constructor(
    readonly code: "failed" | "timeout" | "tooLarge" | "lockLost",
    readonly status: number | null,
    readonly diagnostic: string,
  ) {
    super("Project content Git " + code);
  }
}

/** Child Git commands never inherit credentials, repository overrides, hooks or external filters. */
export function projectGitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"])
    if (base[key] !== undefined) env[key] = base[key];
  return {
    ...env,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_LITERAL_PATHSPECS: "1",
  };
}

const projectGitOptions = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.autocrlf=false",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "core.filesRefLockTimeout=0",
  "-c",
  "core.fsync=committed,reference",
  "-c",
  "core.fsyncMethod=fsync",
]);

/** Long-lived ref transactions use the same isolated process boundary as individual commands. */
export function startProjectGit(directory: string, args: readonly string[], identity?: ContentAuthor) {
  const env = projectGitEnvironment();
  if (identity) {
    if (!identity.name || !identity.email || /[\r\n\0]/.test(identity.name + identity.email))
      throw new ProjectGitError("failed", null, "Invalid content author");
    Object.assign(env, {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    });
  }
  return spawn("git", [...projectGitOptions, "-C", directory, ...args], { env, stdio: "pipe" });
}

/** This adapter is internal to the owned-project Git implementation, not a document/plugin command API. */
export function projectGit(
  directory: string,
  args: readonly string[],
  options: { input?: Uint8Array | string; bytes?: number; timeoutMs?: number; identity?: ContentAuthor } = {},
): Promise<Buffer> {
  const limit = options.bytes ?? 8 * 1024 * 1024,
    timeout = options.timeoutMs ?? 30000;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > PROJECT_CONTENT_LIMITS.gitBytes ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 300000
  )
    return Promise.reject(new ProjectGitError("failed", null, "Invalid Git resource budget"));
  if (options.input && Buffer.byteLength(options.input) > PROJECT_CONTENT_LIMITS.gitBytes)
    return Promise.reject(new ProjectGitError("tooLarge", null, "Git input exceeds its resource budget"));
  return new Promise((resolve, reject) => {
    const child = startProjectGit(directory, args, options.identity),
      chunks: Buffer[] = [],
      errors: Buffer[] = [];
    let bytes = 0,
      errorBytes = 0,
      reason: "timeout" | "tooLarge" | null = null,
      readersReady = false,
      earlyClose: number | null | undefined,
      force: ReturnType<typeof setTimeout> | undefined;
    const stop = (value: "timeout" | "tooLarge") => {
      if (reason) return;
      reason = value;
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 2000);
      force.unref();
    };
    const timer = setTimeout(() => stop("timeout"), timeout);
    child.stdin.on("error", () => {
      // The close event retains the Git exit status after an early pipe closure.
    });
    child.once("error", (cause) => {
      clearTimeout(timer);
      clearTimeout(force);
      reject(new ProjectGitError("failed", null, cause.message));
    });
    const finish = (code: number | null) => {
      if (!readersReady) {
        earlyClose = code;
        return;
      }
      clearTimeout(timer);
      clearTimeout(force);
      if (reason || code !== 0)
        reject(new ProjectGitError(reason || "failed", code, Buffer.concat(errors).toString("utf8")));
      else resolve(Buffer.concat(chunks));
    };
    child.once("close", finish);
    // Completion must be observed before activating streams that can drain an already-finished child.
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) stop("tooLarge");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes <= 16384) errors.push(chunk);
      else stop("tooLarge");
    });
    readersReady = true;
    child.stdin.end(options.input);
    if (earlyClose !== undefined) finish(earlyClose);
  });
}
