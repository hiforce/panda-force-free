import { constants } from "node:fs";
import { open, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { HarnessError } from "../../../shared/harness/contracts.js";
import { isRecord } from "../../../shared/records.js";
import { grokCredentialSnapshot, MAX_CREDENTIAL_BYTES } from "./snapshot.js";
import type { HarnessCredentialSource, HarnessCredentialSnapshot } from "./contracts.js";

/** One account-side owner coalesces refreshes; the native CLI owns OAuth and durable token rotation. */
export class GrokAccountCredentials implements HarnessCredentialSource {
  private refreshing: Promise<HarnessCredentialSnapshot> | null = null;
  private cooldown: { generation: string; until: number; error?: HarnessError } | null = null;
  constructor(
    private readonly options: {
      accountHome: string;
      renew(): Promise<void>;
      now?: () => number;
      refreshBufferMs?: number;
    },
  ) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private async read() {
    try {
      const file = await open(join(this.options.accountHome, "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES || stat.mode & 0o077) throw Error();
        const value: unknown = JSON.parse(await file.readFile("utf8"));
        const snapshot = grokCredentialSnapshot(value);
        const canRefresh =
          isRecord(value) &&
          Object.values(value).some(
            (entry) => isRecord(entry) && typeof entry.refresh_token === "string" && entry.refresh_token,
          );
        return { snapshot, canRefresh };
      } finally {
        await file.close();
      }
    } catch {
      throw new HarnessError("authentication", 503);
    }
  }
  async snapshot(rejectedGeneration?: string): Promise<HarnessCredentialSnapshot> {
    if (rejectedGeneration !== undefined && !/^[a-f0-9]{64}$/.test(rejectedGeneration))
      throw new HarnessError("invalidInput");
    if (this.refreshing) return this.refreshing;
    const { snapshot, canRefresh } = await this.read();
    if (this.refreshing) return this.refreshing;
    const rejected = rejectedGeneration === snapshot.generation;
    const nearExpiry =
      snapshot.expiresAt !== null && snapshot.expiresAt <= this.now() + (this.options.refreshBufferMs ?? 300000);
    if (!rejected && !nearExpiry) return snapshot;
    if (this.cooldown?.generation === snapshot.generation && this.cooldown.until > this.now()) {
      if (
        rejected ||
        (snapshot.expiresAt !== null && snapshot.expiresAt <= this.now() + (this.cooldown.error ? 30000 : 1000))
      )
        throw this.cooldown.error ?? new HarnessError("authentication", 503);
      return snapshot;
    }
    if (!canRefresh) {
      if (rejected || (snapshot.expiresAt !== null && snapshot.expiresAt <= this.now() + 1000))
        throw new HarnessError("authentication", 503);
      return snapshot;
    }
    const work = (async () => {
      try {
        await this.options.renew();
        const current = (await this.read()).snapshot;
        if (current.principal !== snapshot.principal) throw new HarnessError("authentication", 503);
        if (
          (current.expiresAt !== null && current.expiresAt <= this.now() + 1000) ||
          (rejected && current.generation === snapshot.generation)
        )
          throw new HarnessError("authentication", 503);
        this.cooldown = { generation: current.generation, until: this.now() + 30000 };
        return current;
      } catch (error) {
        let safe = error instanceof HarnessError ? error : new HarnessError("unavailable", 503);
        const renewed = await this.read().catch(() => null);
        if (!renewed || renewed.snapshot.principal !== snapshot.principal)
          safe = new HarnessError("authentication", 503);
        else if (
          renewed.snapshot.generation !== snapshot.generation &&
          renewed.snapshot.expiresAt !== null &&
          renewed.snapshot.expiresAt > this.now() + 30000
        ) {
          // Some CLI versions finish rotating auth before an unrelated catalog request times out.
          this.cooldown = { generation: renewed.snapshot.generation, until: this.now() + 30000 };
          return renewed.snapshot;
        }
        this.cooldown = { generation: snapshot.generation, until: this.now() + 30000, error: safe };
        // A transient refresh failure need not reject a still-usable access token in the early buffer.
        if (
          !rejected &&
          safe.code !== "authentication" &&
          snapshot.expiresAt !== null &&
          snapshot.expiresAt > this.now() + 30000
        )
          return snapshot;
        throw safe;
      }
    })();
    this.refreshing = work;
    try {
      return await work;
    } finally {
      if (this.refreshing === work) this.refreshing = null;
    }
  }
}

/** Listing models exercises native auth without creating a session, prompt, tool execution or terminal login. */
export async function renewGrokAccount(options: {
  command: string;
  accountHome: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}) {
  const directory = await mkdtemp(join(tmpdir(), "pf-grok-auth-"));
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const name of [
      "PATH",
      "HOME",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
    ])
      if ((options.env ?? process.env)[name]) env[name] = (options.env ?? process.env)[name];
    env.GROK_HOME = options.accountHome;
    env.GROK_DISABLE_AUTOUPDATER = "1";
    env.GROK_SHARED_DAEMON = "false";
    const child = spawn(
      "flock",
      [
        "--exclusive",
        "--wait",
        "15",
        join(options.accountHome, ".panda-force-auth-refresh.lock"),
        options.command,
        "--no-auto-update",
        "--leader-socket",
        join(directory, "leader.sock"),
        "models",
      ],
      { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
    );
    await new Promise<void>((resolve, reject) => {
      let diagnostic = "",
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, options.timeoutMs ?? 25000);
      // Keep only a bounded private diagnostic for error classification; never return native prose or output.
      const drain = (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString("utf8")).slice(-8192);
      };
      child.stdout.on("data", drain);
      child.stderr.on("data", drain);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new HarnessError("unavailable", 503));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (timedOut) reject(new HarnessError("timeout", 504));
        else if (code === 0) resolve();
        else
          reject(
            new HarnessError(
              /invalid_grant|refresh.token.{0,30}(?:revoked|invalid|expired)/i.test(diagnostic)
                ? "authentication"
                : "unavailable",
              503,
            ),
          );
        diagnostic = "";
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
