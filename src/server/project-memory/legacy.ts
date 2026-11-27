import { errorCode, errorStatus } from "../../shared/errors.js";
import { HarnessError } from "../../shared/harness/contracts.js";
import { legacyMemoryPath, type MemoryManualConvention } from "../../shared/project-memory/contracts.js";
import { isRecord } from "../../shared/records.js";
import { matchesCookieMutationOrigin } from "../auth/origin.js";
import { readHarnessSourcePage } from "../harness/source-history.js";
import { readJsonBody, RequestBodyError } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import type { Route, RouteContext } from "../http/router.js";
import type { SessionHistory } from "../engines/runtime-contract.js";
import type { HarnessPrincipal } from "../harness/registry.js";
import type { ProjectDirectoryPolicy } from "../projects/directory-policy.js";
import type { ProjectSessionMembership } from "../projects/session-membership.js";
import type { MemoryArchiveAuthorize } from "./portability.js";
import { extractMemoryClaims, memoryControlPattern, visibleNativeMemoryText } from "./rules.js";
import type { NativeMemoryJournal } from "./native-journal.js";
import type { ProjectMemory } from "./service.js";

const batchSize = 8;
const reservedContext = /<\/?panda_(?:attachment_workspace|session_skills)\b/u;
const denied = (error: unknown) => {
  const code = errorCode(error);
  const status = errorStatus(error);
  return code === "forbidden" || code === "notFound" || status === 403 || status === 404;
};

function parseConventions(input: unknown): MemoryManualConvention[] {
  if (!Array.isArray(input) || !input.length || input.length > batchSize) throw new HarnessError("invalidInput");
  return input.map((item) => {
    if (!isRecord(item)) throw new HarnessError("invalidInput");
    const { key, scope = "project", value } = item;
    if (typeof key !== "string" || typeof scope !== "string" || typeof value !== "string")
      throw new HarnessError("invalidInput");
    if (
      [key, scope, value].some(
        (field) => !field.trim() || memoryControlPattern.test(field) || reservedContext.test(field),
      )
    )
      throw new HarnessError("invalidInput");
    const [claim] = extractMemoryClaims(
      "Project convention [" + scope.trim() + "]: " + key.trim() + " = " + value.trim(),
    );
    if (!claim?.key || !claim.scope || claim.value !== value.trim()) throw new HarnessError("invalidInput");
    return { key: claim.key, scope: claim.scope, value: claim.value };
  });
}

export function legacyMemoryRoute(options: {
  memory: ProjectMemory;
  journal: NativeMemoryJournal;
  principal(context: RouteContext): HarnessPrincipal;
  authorize: MemoryArchiveAuthorize;
  membership(id: string): Promise<ProjectSessionMembership | null>;
  history: SessionHistory;
  directory: ProjectDirectoryPolicy;
}): Route {
  return {
    path: (path) => path.startsWith(legacyMemoryPath),
    method: ["GET", "POST", "PATCH"],
    async handler(context) {
      const { req, res, url } = context;
      res.setHeader("Cache-Control", "private, no-store");
      try {
        const principal = options.principal(context);
        const id = url.pathname.slice(legacyMemoryPath.length);
        if (!principal.administrator || !/^[a-zA-Z0-9-]{1,128}$/u.test(id)) throw new HarnessError("notFound", 404);
        const membership = await options.membership(id);
        if (!membership || membership.projectId === "personal") throw new HarnessError("notFound", 404);
        const { projectId } = membership;
        const { owner } = principal;
        await options.authorize(owner, projectId, "read");
        const native = await options.history.getThreadMetadata(id);
        if (
          native.id !== id ||
          !native.cwd ||
          !options.directory.remember(native) ||
          !options.directory.allowsPath(native.cwd)
        )
          throw new HarnessError("notFound", 404);
        const canSave = await options.authorize(owner, projectId, "contribute").then(
          () => true,
          (error: unknown) => {
            if (denied(error)) return false;
            throw error;
          },
        );
        const destination = {
          owner,
          projectId,
          id,
          cwd: native.cwd,
        };
        if (req.method === "PATCH") {
          if (!canSave || !matchesCookieMutationOrigin(req)) throw new HarnessError("forbidden", 403);
          const input = await readJsonBody(req, 1024);
          if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || typeof input.enabled !== "boolean")
            throw new HarnessError("invalidInput");
          await options.journal.configure(destination, Number(input.revision), input.enabled);
        }
        if (req.method === "POST") {
          if (!canSave || !matchesCookieMutationOrigin(req)) throw new HarnessError("forbidden", 403);
          const input = await readJsonBody(req, 16 * 1024);
          const entries = await options.memory.saveLegacy(
            owner,
            projectId,
            { id, cwd: native.cwd },
            parseConventions(input.entries),
          );
          respondJson(res, 200, { canSave, entries, automatic: await options.journal.view(destination) });
          return;
        }
        const entries = await options.memory.legacyRecords(owner, projectId, id);
        if (req.method === "PATCH" || url.searchParams.get("preview") !== "true") {
          respondJson(res, 200, { canSave, entries, automatic: await options.journal.view(destination) });
          return;
        }
        if (!canSave) throw new HarnessError("forbidden", 403);
        const latest = await readHarnessSourcePage(options.history, id, native.cwd);
        const seen = new Set(entries.map((entry) => JSON.stringify(entry)));
        const candidates: MemoryManualConvention[] = [];
        for (const message of latest.history.toReversed()) {
          if (message.role !== "user") continue;
          const text = visibleNativeMemoryText(message.text);
          for (const { key, scope, value } of extractMemoryClaims(text)) {
            const candidate = { key, scope, value };
            const identity = JSON.stringify(candidate);
            if (!key || !scope || reservedContext.test(value) || seen.has(identity)) continue;
            seen.add(identity);
            candidates.push(candidate);
            if (candidates.length === batchSize) break;
          }
          if (candidates.length === batchSize) break;
        }
        respondJson(res, 200, { candidates });
      } catch (error) {
        const known =
          error instanceof HarnessError
            ? error
            : error instanceof RequestBodyError
              ? new HarnessError("invalidInput", error.status)
              : denied(error)
                ? new HarnessError("notFound", 404)
                : new HarnessError("unavailable", 503);
        const label = "harness.error" + known.code[0]!.toUpperCase() + known.code.slice(1);
        respondJson(res, known.status, { error: label, messageId: label, code: known.code });
      }
    },
  };
}
