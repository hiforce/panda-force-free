import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseOperation, DatabaseMigrationPlan } from "../../../shared/database/contracts.js";
import type { ApplicationDatabaseConfig } from "../config.js";
import { readPrivateDatabaseFile } from "../config.js";
import { DatabaseManagementError } from "./errors.js";

export const databaseIdentifier = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export const missingFile = (error: unknown) =>
  !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
export interface DatabaseInstallation {
  schema: 1;
  id: string;
  initialChoiceRequired: boolean;
  createdAt: number;
}
export interface StoredDatabasePlan {
  schema: 1;
  owner: string;
  config: Extract<ApplicationDatabaseConfig, { driver: "mysql" }>;
  public: DatabaseMigrationPlan;
}
export interface StoredDatabaseOperation {
  schema: 1;
  owner: string;
  planId: string;
  statusTokenHash: string;
  tokenExpiresAt: number;
  public: DatabaseOperation;
}
const stateQueues = new Map<string, Promise<void>>();

/** Recovery metadata and write-only connection plans stay independent of either selected business backend. */
export class DatabaseManagementState {
  readonly root: string;
  constructor(readonly stateRoot: string) {
    this.root = resolve(stateRoot, "database-management");
  }
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = (stateQueues.get(this.root) ?? Promise.resolve()).then(work);
    const settled = result.then(
      () => {},
      () => {},
    );
    stateQueues.set(this.root, settled);
    void settled.then(() => {
      if (stateQueues.get(this.root) === settled) stateQueues.delete(this.root);
    });
    return result;
  }
  async directory(name = "") {
    if (name && !/^[a-z-]+$/.test(name)) throw new DatabaseManagementError("invalidDatabaseConfiguration");
    if (name) await this.directory();
    const path = join(this.root, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new DatabaseManagementError("databaseUnavailable", 503);
    return path;
  }
  private location(area: "plans" | "operations" | "", name: string) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new DatabaseManagementError("operationNotFound", 404);
    return join(this.root, area, name + ".json");
  }
  async read<T>(area: "plans" | "operations" | "", name: string): Promise<T | null> {
    try {
      await this.directory(area);
      return JSON.parse((await readPrivateDatabaseFile(this.location(area, name), 1024 * 1024)).toString("utf8"));
    } catch (error) {
      if (missingFile(error)) return null;
      throw new DatabaseManagementError("databaseUnavailable", 503);
    }
  }
  async write(area: "plans" | "operations" | "", name: string, value: unknown, exclusive = false) {
    await this.directory(area);
    const path = this.location(area, name),
      temporary = exclusive ? path : path + "." + randomUUID(),
      bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw new DatabaseManagementError("databaseUnavailable", 503);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    if (!exclusive) await rename(temporary, path);
    await this.syncDirectory(area);
  }
  private async syncDirectory(area: "plans" | "operations" | "") {
    if (process.platform === "win32") return;
    const directory = await open(join(this.root, area), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async clearPending(id: string) {
    const current = await this.read<{ operationId: string }>("", "pending");
    if (!current) return;
    if (current.operationId !== id) throw new DatabaseManagementError("migrationAlreadyRunning", 409);
    await unlink(this.location("", "pending"));
    await this.syncDirectory("");
  }
  /** Delete a bounded number of expired credentials, retaining every unfinished operation's plan. */
  async pruneExpiredPlans(now = Date.now(), limit = 16): Promise<number> {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 64)
      throw new DatabaseManagementError("invalidDatabaseConfiguration");
    return this.exclusive(async () => {
      const plans = await this.directory("plans"),
        operations = await this.directory("operations");
      const pending = await this.read<{ operationId: string }>("", "pending");
      if (pending && !databaseIdentifier(pending.operationId)) return 0;
      const retained = new Set<string>();
      let pendingFound = !pending;
      for (const file of await readdir(operations)) {
        const id = file.endsWith(".json") ? file.slice(0, -5) : "";
        if (!databaseIdentifier(id)) continue;
        let operation: StoredDatabaseOperation | null;
        try {
          operation = await this.read<StoredDatabaseOperation>("operations", id);
        } catch {
          return 0;
        }
        // Unreadable or unrecognised receipts must never cause credentials to be discarded.
        if (
          !operation ||
          operation.schema !== 1 ||
          operation.public?.id !== id ||
          !databaseIdentifier(operation.planId) ||
          !["waiting-restart", "running", "failed", "complete", "canceled"].includes(operation.public.status)
        )
          return 0;
        if (pending?.operationId === id) pendingFound = true;
        if (pending?.operationId === id || !["complete", "canceled"].includes(operation.public.status))
          retained.add(operation.planId);
      }
      if (!pendingFound) return 0;
      let removed = 0;
      for (const file of await readdir(plans)) {
        if (removed === limit) break;
        const id = file.endsWith(".json") ? file.slice(0, -5) : "";
        if (!databaseIdentifier(id) || retained.has(id)) continue;
        const path = this.location("plans", id);
        try {
          const before = await lstat(path);
          if (
            !before.isFile() ||
            before.isSymbolicLink() ||
            (process.platform !== "win32" && (before.mode & 0o777) !== 0o600)
          )
            continue;
          const plan = await this.read<StoredDatabasePlan>("plans", id);
          if (
            !plan ||
            plan.schema !== 1 ||
            typeof plan.owner !== "string" ||
            plan.config?.driver !== "mysql" ||
            plan.public?.id !== id ||
            !Number.isSafeInteger(plan.public.expiresAt) ||
            plan.public.expiresAt > now
          )
            continue;
          const current = await lstat(path);
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.ino !== before.ino ||
            current.dev !== before.dev ||
            current.mtimeMs !== before.mtimeMs ||
            current.ctimeMs !== before.ctimeMs ||
            current.size !== before.size ||
            (process.platform !== "win32" && (current.mode & 0o777) !== 0o600)
          )
            continue;
          await unlink(path);
          removed++;
        } catch (error) {
          if (missingFile(error) || error instanceof DatabaseManagementError) continue;
          throw error;
        }
      }
      if (removed) await this.syncDirectory("plans");
      return removed;
    });
  }
  async installation(initialChoiceRequired: boolean) {
    return this.exclusive(async () => {
      const existing = await this.read<DatabaseInstallation>("", "installation");
      if (existing !== null) {
        if (
          existing.schema !== 1 ||
          !databaseIdentifier(existing.id) ||
          typeof existing.initialChoiceRequired !== "boolean"
        )
          throw new DatabaseManagementError("databaseUnavailable", 503);
        return existing;
      }
      // A Bot-first installation keeps its identity when the remaining domains join it.
      let id = randomUUID();
      try {
        const bot = JSON.parse(
          (
            await readPrivateDatabaseFile(join(this.stateRoot, "database-migrations", "bots", "installation.json"))
          ).toString("utf8"),
        );
        if (bot.schema !== 1 || !databaseIdentifier(bot.id)) throw Error("Invalid installation marker");
        id = bot.id;
      } catch (error) {
        if (!missingFile(error)) throw new DatabaseManagementError("databaseUnavailable", 503);
      }
      const result: DatabaseInstallation = { schema: 1, id, initialChoiceRequired, createdAt: Date.now() };
      try {
        await this.write("", "installation", result, true);
        return result;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        const winner = await this.read<DatabaseInstallation>("", "installation");
        if (!winner || winner.schema !== 1 || !databaseIdentifier(winner.id))
          throw new DatabaseManagementError("databaseUnavailable", 503);
        return winner;
      }
    });
  }
}
