import { isRecord } from "../../../shared/records.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RouteContext } from "../../http/router.js";
import { readJsonBody, RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { DatabaseManagementError } from "./errors.js";
import { DatabaseManagementState, databaseIdentifier, type StoredDatabaseOperation } from "./state.js";

export interface DatabaseHostRecoveryMarker {
  operationId: string;
  secret: string;
}
const capability = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Only a host administrator who can read the private state volume can replace a lost browser capability. */
export async function initializeDatabaseHostRecovery(options: { state: DatabaseManagementState; operationId: string }) {
  const { state, operationId } = options;
  if (!databaseIdentifier(operationId)) throw new DatabaseManagementError("operationNotFound", 404);
  const marker = await state.exclusive(async () => {
    if ((await state.read<{ operationId: string }>("", "pending"))?.operationId !== operationId)
      throw new DatabaseManagementError("operationNotFound", 404);
    const saved = await state.read<DatabaseHostRecoveryMarker>("", "host-recovery");
    if (saved && (!databaseIdentifier(saved.operationId) || !capability(saved.secret)))
      throw new DatabaseManagementError("databaseUnavailable", 503);
    const next =
      saved?.operationId === operationId ? saved : { operationId, secret: randomBytes(32).toString("base64url") };
    await state.write("", "host-recovery", next);
    return next;
  });
  return {
    async handle(context: RouteContext): Promise<boolean> {
      if (context.url.pathname !== "/api/system/database/host-recovery") return false;
      const reply = (status: number, value: unknown) =>
        respondJson(context.res, status, value, { "cache-control": "no-store" });
      try {
        if (context.req.method !== "POST") throw new DatabaseManagementError("operationNotFound", 404);
        const origin = context.req.headers.origin;
        if (
          typeof origin !== "string" ||
          !origin ||
          !matchesRequestOrigin({
            hostHeader: context.req.headers.host,
            origin,
            fetchSite: context.req.headers["sec-fetch-site"],
          })
        )
          throw new DatabaseManagementError("administratorRequired", 403);
        const supplied = context.req.headers["x-panda-database-host-recovery"];
        if (
          !capability(supplied) ||
          !timingSafeEqual(Buffer.from(hash(supplied), "hex"), Buffer.from(hash(marker.secret), "hex"))
        )
          throw new DatabaseManagementError("operationTokenInvalid", 401);
        const input = await readJsonBody(context.req, 1024);
        if (!isRecord(input) || Object.keys(input).length !== 1 || !capability(input.statusToken))
          throw new DatabaseManagementError("invalidDatabaseConfiguration");
        await state.exclusive(async () => {
          const pending = await state.read<{ operationId: string }>("", "pending");
          const record = await state.read<StoredDatabaseOperation>("operations", operationId);
          if (
            pending?.operationId !== operationId ||
            !record ||
            record.schema !== 1 ||
            record.public?.id !== operationId
          )
            throw new DatabaseManagementError("operationNotFound", 404);
          if (record.public.status !== "failed" || !record.public.canRetry)
            throw new DatabaseManagementError("migrationAlreadyRunning", 409);
          const statusTokenHash = hash(input.statusToken as string);
          if (record.statusTokenHash !== statusTokenHash)
            await state.write("operations", operationId, {
              ...record,
              statusTokenHash,
              tokenExpiresAt: Date.now() + 7 * 86400000,
            });
        });
        reply(200, { operationId, recovered: true });
      } catch (error) {
        const known = error instanceof DatabaseManagementError;
        reply(known ? error.status : error instanceof RequestBodyError ? error.status : 503, {
          error: {
            code: known
              ? error.code
              : error instanceof RequestBodyError
                ? "invalidDatabaseConfiguration"
                : "databaseUnavailable",
          },
        });
      }
      return true;
    },
  };
}
