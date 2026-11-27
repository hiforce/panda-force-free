import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  memoryArchiveId,
  memoryArchiveMaxBytes,
  memoryPackageChunkBytes,
  memoryPackageExtension,
  memoryPackageMediaType,
} from "../../shared/project-memory/archive.js";
import { isRecord } from "../../shared/records.js";
import { memoryPreferencesPath } from "../../shared/project-memory/language.js";
import type { MemoryModelPolicy } from "../../shared/project-memory/contracts.js";
import { errorCode, errorStatus } from "../../shared/errors.js";
import { HarnessError } from "../../shared/harness/contracts.js";
import { matchesCookieMutationOrigin } from "../auth/origin.js";
import { contentAccessProject } from "../content-access/contracts.js";
import type { HarnessPrincipal } from "../harness/registry.js";
import { readJsonBody, RequestBodyError } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import { readRequestBytes, releaseRequestBytes } from "../request-bytes.js";
import { encodeMemoryPackage, memoryPackageRecipient, MemoryPackageError } from "./pmf.js";
import { memoryPackageUploads } from "./pmf-uploads.js";
import type { Route, RouteContext } from "../http/router.js";
import type { MemoryArchiveAuthorize } from "./portability.js";
import type { RemoteMemoryPackages } from "./pmf-remote.js";
import type { HarnessMetadataTransaction } from "../harness/ports.js";
import { materialSelection, type MemoryMaterialStore } from "./materials.js";
import { MemoryMaterialPreviews, materialRequestSignal } from "./material-previews.js";
import { prepareMemoryMaterials, type OpenMemoryMaterials } from "./pmf-materials.js";
import type { ProjectMemory } from "./service.js";
import type { MemoryNativeCopies } from "./native-copies.js";
import { DocumentError } from "../documents/errors.js";

function modelPolicy(input: unknown): MemoryModelPolicy | undefined {
  if (input === undefined) return;
  if (!isRecord(input) || typeof input.enabled !== "boolean") throw new HarnessError("invalidInput");
  const selection = input.selection;
  if (selection === null) return { enabled: input.enabled, selection: null };
  if (
    !isRecord(selection) ||
    typeof selection.runtimeId !== "string" ||
    !/^[a-zA-Z0-9-]{1,64}$/u.test(selection.runtimeId) ||
    typeof selection.model !== "string" ||
    selection.model.length > 200 ||
    typeof selection.effort !== "string" ||
    selection.effort.length > 64
  )
    throw new HarnessError("invalidInput");
  return {
    enabled: input.enabled,
    selection: { runtimeId: selection.runtimeId, model: selection.model, effort: selection.effort },
  };
}

export function projectMemoryRoutes(options: {
  memory: ProjectMemory;
  principal(context: RouteContext): HarnessPrincipal;
  authorize: MemoryArchiveAuthorize;
  remotePackages?: RemoteMemoryPackages;
  materials?: MemoryMaterialStore;
  previews?: MemoryMaterialPreviews;
  copies?: MemoryNativeCopies;
}): Route[] {
  const uploads = memoryPackageUploads();
  const previews = options.previews ?? new MemoryMaterialPreviews();
  const pattern =
    /^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(memory-policy|memory-language|memory-model-review|memory-team|memory-index|memory-terrain|memory-source|memory-upload|memory-materials|memory-material|memory-material-preview|memory-material-copy|memory-export-preview|memory-export|memory-import-preview|memory-import|memory-import-withdraw|memory)(?:\/([a-f0-9]{64}))?$/u;
  return [
    {
      path: memoryPreferencesPath,
      method: ["GET", "PATCH"],
      async handler(context) {
        context.res.setHeader("Cache-Control", "private, no-store");
        try {
          const { owner } = options.principal(context);
          if (context.req.method === "GET") {
            respondJson(context.res, 200, await options.memory.preferences(owner));
            return;
          }
          if (!matchesCookieMutationOrigin(context.req)) throw new HarnessError("forbidden", 403);
          const input = await readJsonBody(context.req, 1024);
          respondJson(context.res, 200, await options.memory.setPreferences(owner, input.revision, input.language));
        } catch (error) {
          const known =
            error instanceof HarnessError
              ? error
              : error instanceof RequestBodyError
                ? new HarnessError("invalidInput", error.status)
                : new HarnessError("unavailable", 503);
          const messageId = `harness.error${known.code[0]!.toUpperCase()}${known.code.slice(1)}`;
          respondJson(context.res, known.status, { error: messageId, messageId, code: known.code });
        }
      },
    },
    {
      path: (pathname) => pattern.test(pathname),
      method: ["GET", "PATCH", "POST", "DELETE"],
      async handler(context) {
        try {
          const [, project, action, id] = pattern.exec(context.url.pathname)!;
          const principal = options.principal(context);
          const teamRead = action === "memory-team" && context.req.method === "GET";
          if (!principal.administrator && action !== "memory-team") throw new HarnessError("forbidden", 403);
          const projectId = contentAccessProject(project);
          if (projectId === "personal") throw new HarnessError("notFound", 404);
          const packageWrite =
            action === "memory-upload" ||
            (context.req.method === "POST" &&
              ["memory-import-preview", "memory-import", "memory-import-withdraw", "memory-material-copy"].includes(
                action,
              ));
          await options.authorize(principal.owner, projectId, packageWrite ? "contribute" : "read");
          context.res.setHeader("Cache-Control", "private, no-store");
          if (action === "memory-team") {
            if (teamRead && !id) {
              const canPublish =
                principal.administrator &&
                (await options.authorize(principal.owner, projectId, "contribute").then(
                  () => true,
                  (error) => {
                    if (["forbidden", "notFound"].includes(errorCode(error)) || [403, 404].includes(errorStatus(error)))
                      return false;
                    throw error;
                  },
                ));
              respondJson(context.res, 200, await options.memory.teamView(principal.owner, projectId, canPublish));
              return;
            }
            if (!id || context.req.method !== "POST") throw new HarnessError("notFound", 404);
            if (!matchesCookieMutationOrigin(context.req)) throw new HarnessError("forbidden", 403);
            const input = await readJsonBody(context.req, 4096);
            if (input.action !== "withdraw") {
              if (!principal.administrator) throw new HarnessError("forbidden", 403);
              await options.authorize(principal.owner, projectId, "contribute");
            }
            if (input.action === "preview") {
              respondJson(context.res, 200, await options.memory.team.preview(principal.owner, projectId, id));
              return;
            }
            if (input.action === "publish" && typeof input.token === "string" && /^[a-f0-9]{64}$/u.test(input.token)) {
              respondJson(
                context.res,
                200,
                await options.memory.team.publish(principal.owner, projectId, id, input.token),
              );
              return;
            }
            if (input.action === "withdraw" && Number.isSafeInteger(input.revision) && Number(input.revision) > 0) {
              respondJson(
                context.res,
                200,
                await options.memory.team.withdraw(principal.owner, projectId, id, Number(input.revision)),
              );
              return;
            }
            throw new HarnessError("invalidInput");
          }
          if (action === "memory-upload" && !id) {
            const { req, res, url } = context;
            const upload = url.searchParams.get("upload");
            const remotePackages = options.remotePackages;
            if (upload === null && req.method === "GET") {
              respondJson(res, 200, {
                remote: (await remotePackages?.available()) ?? false,
                transfers: (await remotePackages?.list(principal.owner, projectId)) ?? [],
              });
              return;
            }
            if (upload === null && req.method === "POST") {
              const { name, size } = await readJsonBody(req, 4096);
              const remote = await remotePackages?.startUpload(principal.owner, projectId, name, size);
              respondJson(res, 201, remote ?? (await uploads.start(principal.owner, projectId, name, size)));
              return;
            }
            if (!upload || !memoryArchiveId.test(upload)) throw new HarnessError("invalidInput");
            if (req.method === "DELETE") {
              if (!(await remotePackages?.discard(principal.owner, projectId, upload)))
                await uploads.discard(principal.owner, projectId, upload);
              res.writeHead(204).end();
              return;
            }
            const remote = await remotePackages?.status(principal.owner, projectId, upload);
            if (req.method === "GET") {
              respondJson(res, 200, remote ?? uploads.status(principal.owner, projectId, upload));
              return;
            }
            if (req.method === "POST" && remote && url.searchParams.get("retry") === "1") {
              respondJson(res, 202, await remotePackages!.retry(principal.owner, projectId, upload));
              return;
            }
            const offset = Number(url.searchParams.get("offset") ?? NaN);
            if (
              req.method !== "POST" ||
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              req.headers["content-type"] !== "application/octet-stream"
            )
              throw new HarnessError("invalidInput");
            try {
              respondJson(
                res,
                200,
                remote
                  ? await remotePackages!.append(
                      principal.owner,
                      projectId,
                      upload,
                      offset,
                      await readRequestBytes(req, remote.chunkBytes!),
                    )
                  : await uploads.append(principal.owner, projectId, upload, offset, () =>
                      readRequestBytes(req, memoryPackageChunkBytes),
                    ),
              );
            } finally {
              releaseRequestBytes(req);
            }
            return;
          }
          if (action === "memory-materials" && !id && context.req.method === "GET" && options.materials) {
            const type = context.url.searchParams.get("type");
            if (type !== "document" && type !== "files") throw new HarnessError("invalidInput");
            const cursor = context.url.searchParams.get("cursor") ?? undefined;
            if (cursor && cursor.length > 512) throw new HarnessError("invalidInput");
            respondJson(context.res, 200, await options.materials.catalog(principal.owner, projectId, type, cursor));
            return;
          }
          if (
            (action === "memory-material" || action === "memory-material-preview") &&
            !id &&
            context.req.method === "GET" &&
            options.materials
          ) {
            const packageId = context.url.searchParams.get("package") ?? "";
            const material = context.url.searchParams.get("id") ?? "";
            const digest = context.url.searchParams.get("digest") ?? "";
            const name = context.url.searchParams.get("name") ?? "";
            if (
              !memoryArchiveId.test(packageId) ||
              !/^[\w-]{1,128}$/u.test(material) ||
              !/^[a-f0-9]{64}$/u.test(digest) ||
              name.length < 1 ||
              name.length > 240
            )
              throw new HarnessError("invalidInput");
            const authorize = async () => {
              await options.authorize(principal.owner, projectId, "read");
              return options.memory.archiveMaterial(principal.owner, projectId, packageId, material, digest, name);
            };
            const stored = await authorize();
            const read = () =>
              options.materials!.read(principal.owner, projectId, stored.checksum, digest, stored.file.size);
            if (action === "memory-material-preview") {
              const { signal, release } = materialRequestSignal(context);
              try {
                await previews.respond(
                  context,
                  {
                    identity: ["package", principal.owner, projectId, packageId, material, digest],
                    kind: stored.kind,
                    file: stored.file,
                    verify: authorize,
                    read,
                  },
                  signal,
                );
              } finally {
                release();
              }
              return;
            }
            const bytes = await read();
            await authorize();
            const filename = encodeURIComponent(stored.file.name).replace(
              /[!'()*]/gu,
              (character) => "%" + character.charCodeAt(0).toString(16),
            );
            context.res
              .writeHead(200, {
                "content-type": "application/octet-stream",
                "cache-control": "private, no-store",
                "content-disposition": "attachment; filename*=UTF-8''" + filename,
                "content-length": bytes.length,
                "x-content-type-options": "nosniff",
              })
              .end(bytes);
            return;
          }
          if (
            action === "memory-material-copy" &&
            !id &&
            context.req.method === "POST" &&
            options.materials &&
            options.copies
          ) {
            const { packageId, materialId } = await readJsonBody(context.req, 2048);
            if (
              typeof packageId !== "string" ||
              !memoryArchiveId.test(packageId) ||
              typeof materialId !== "string" ||
              !/^[\w-]{1,128}$/u.test(materialId)
            )
              throw new HarnessError("invalidInput");
            const { owner } = principal;
            const stored = await options.memory.archiveMaterialSource(owner, projectId, packageId, materialId);
            const { signal, release } = materialRequestSignal(context);
            try {
              const copy = await options.copies.copy(
                owner,
                projectId,
                {
                  packageId,
                  material: stored.material,
                  read: (file) => options.materials!.read(owner, projectId, stored.checksum, file.digest, file.size),
                  async verify() {
                    await options.authorize(owner, projectId, "contribute");
                    const current = await options.memory.archiveMaterialSource(owner, projectId, packageId, materialId);
                    if (stored.checksum !== current.checksum) throw new HarnessError("conflict", 409);
                  },
                },
                signal,
              );
              respondJson(context.res, 200, copy);
            } catch (error) {
              if (!(error instanceof DocumentError)) throw error;
              const messageId =
                error.status === 413
                  ? "projects.memoryNativeCopyTooLarge"
                  : error.status === 404
                    ? "harness.errorNotFound"
                    : error.status === 409
                      ? "harness.errorConflict"
                      : "projects.memoryNativeCopyUnavailable";
              respondJson(context.res, error.status, { error: messageId, messageId, code: error.code });
            } finally {
              release();
            }
            return;
          }
          if (action === "memory-export-preview" && !id && context.req.method === "GET" && options.materials) {
            const query = context.url.searchParams;
            const [selected] = materialSelection([
              { id: query.get("id"), version: query.get("version"), kind: query.get("kind") },
            ]);
            const source = await options.materials.preview(principal.owner, projectId, selected!);
            const { signal, release } = materialRequestSignal(context);
            try {
              await previews.respond(
                context,
                {
                  ...source,
                  async verify() {
                    await options.authorize(principal.owner, projectId, "read");
                    await source.verify();
                  },
                },
                signal,
              );
            } finally {
              release();
            }
            return;
          }
          if (action === "memory-export" && !id && context.req.method === "GET") {
            respondJson(context.res, 200, {
              references: await options.memory.exportCitations(principal.owner, projectId),
            });
            return;
          }
          if (action === "memory-export" && !id && context.req.method === "POST") {
            const { publicKey, materials } = await readJsonBody(context.req, memoryArchiveMaxBytes);
            const recipient = memoryPackageRecipient(publicKey);
            const selection = materialSelection(materials);
            if (selection.length && !options.materials) throw new HarnessError("notFound", 404);
            const { signal, release } = materialRequestSignal(context);
            const captured = await (async () => {
              try {
                return selection.length
                  ? await options.materials!.exportMaterials(principal.owner, projectId, selection, (source, anchors) =>
                      previews.validate(source, anchors, signal),
                    )
                  : undefined;
              } finally {
                release();
              }
            })();
            await options.authorize(principal.owner, projectId, "read");
            const archive = await options.memory.exportArchive(principal.owner, projectId, captured?.materials);
            const name = `panda-project-memory-${archive.packageId.slice(0, 8)}${memoryPackageExtension}`;
            const headers = {
              "content-type": memoryPackageMediaType,
              "cache-control": "private, no-store",
              "content-disposition": `attachment; filename="${name}"`,
              "x-content-type-options": "nosniff",
            };
            if (captured) {
              const pack = prepareMemoryMaterials(
                { version: 2, memory: archive, materials: captured.materials },
                captured.read,
              );
              await options.authorize(principal.owner, projectId, "read");
              context.res.writeHead(200, headers);
              await pipeline(Readable.from(pack(recipient)), context.res);
              return;
            }
            const bytes = encodeMemoryPackage(archive, recipient);
            context.res.writeHead(200, { ...headers, "content-length": bytes.length }).end(bytes);
            return;
          }
          if (action === "memory-import" && !id && context.req.method === "GET") {
            const packageId = context.url.searchParams.get("package");
            if (packageId !== null && !memoryArchiveId.test(packageId)) throw new HarnessError("invalidInput");
            if (packageId !== null) {
              respondJson(
                context.res,
                200,
                await options.memory.archiveImportRecord(principal.owner, projectId, packageId),
              );
              return;
            }
            const receipts = await options.memory.archiveImports(principal.owner, projectId);
            const history = options.copies
              ? await options.copies.include(principal.owner, projectId, receipts)
              : receipts;
            respondJson(context.res, 200, history);
            return;
          }
          if (
            (action === "memory-import-preview" || action === "memory-import") &&
            !id &&
            context.req.method === "POST"
          ) {
            const { uploadId, token, unlock } = await readJsonBody(context.req, 4096);
            if (typeof uploadId !== "string" || !memoryArchiveId.test(uploadId))
              throw new MemoryPackageError("projects.memoryPackageInvalid");
            if (action === "memory-import" && (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)))
              throw new HarnessError("invalidInput");
            if (
              action === "memory-import-preview" &&
              (typeof unlock !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(unlock))
            )
              throw new MemoryPackageError("projects.memoryPackageUnlockFailed");
            const key =
              typeof unlock === "string" && /^[A-Za-z0-9_-]{43}$/u.test(unlock)
                ? Buffer.from(unlock, "base64url")
                : undefined;
            const requestedToken = action === "memory-import" ? (token as string) : undefined;
            const work = async (
              memory: unknown,
              opened?: OpenMemoryMaterials,
              assertCurrent?: (tx: HarnessMetadataTransaction) => void | Promise<void>,
            ) => {
              if (opened && !options.materials) throw new HarnessError("notFound", 404);
              const media = opened
                ? {
                    materials: opened.materials,
                    assertCurrent: options.materials!.assertCurrent.bind(options.materials),
                  }
                : undefined;
              if (opened && requestedToken === undefined) await opened.verify();
              if (opened && requestedToken !== undefined) {
                const review = await options.memory.archiveImport(
                  principal.owner,
                  projectId,
                  memory,
                  undefined,
                  options.authorize,
                  assertCurrent,
                  media,
                );
                if (!("token" in review) || review.withdrawn || (review.token !== requestedToken && !review.imported))
                  throw new HarnessError("conflict", 409);
                if (!review.imported) await options.materials!.save(principal.owner, projectId, opened);
              }
              return options.memory.archiveImport(
                principal.owner,
                projectId,
                memory,
                requestedToken,
                options.authorize,
                assertCurrent,
                media,
              );
            };
            try {
              const remote = await options.remotePackages?.withPackage(principal.owner, projectId, uploadId, key, work);
              const result = remote
                ? remote.value
                : await uploads.withPackage(principal.owner, projectId, uploadId, key, work);
              respondJson(context.res, 200, result);
            } finally {
              key?.fill(0);
              releaseRequestBytes(context.req);
            }
            return;
          }
          if (action === "memory-import-withdraw" && !id && context.req.method === "POST") {
            const { packageId } = await readJsonBody(context.req, 1024);
            if (typeof packageId !== "string" || !memoryArchiveId.test(packageId))
              throw new HarnessError("invalidInput");
            respondJson(
              context.res,
              200,
              await options.memory.withdrawArchive(principal.owner, projectId, packageId, options.authorize),
            );
            return;
          }
          if (action === "memory-index" && !id && context.req.method === "POST") {
            respondJson(context.res, 202, await options.memory.rebuildIndex(principal.owner, projectId));
            return;
          }
          if (action === "memory-model-review" && !id && context.req.method === "GET") {
            respondJson(context.res, 200, { reviews: await options.memory.modelReviews(principal.owner, projectId) });
            return;
          }
          if (action === "memory-language" && !id) {
            if (context.req.method === "GET") {
              respondJson(context.res, 200, await options.memory.projectLanguage(principal.owner, projectId));
              return;
            }
            if (context.req.method !== "PATCH") throw new HarnessError("notFound", 404);
            await options.authorize(principal.owner, projectId, "contribute");
            if (!matchesCookieMutationOrigin(context.req)) throw new HarnessError("forbidden", 403);
            const input = await readJsonBody(context.req, 1024);
            respondJson(
              context.res,
              200,
              await options.memory.setProjectLanguage(principal.owner, projectId, input.revision, input.language),
            );
            return;
          }
          if (action === "memory-policy" && !id && context.req.method !== "POST") {
            if (context.req.method === "GET") {
              respondJson(context.res, 200, await options.memory.policy(principal.owner, projectId));
              return;
            }
            const input = await readJsonBody(context.req, 8192);
            if (
              !Number.isSafeInteger(input.revision) ||
              typeof input.write !== "boolean" ||
              typeof input.recall !== "boolean"
            )
              throw new HarnessError("invalidInput");
            respondJson(
              context.res,
              200,
              await options.memory.configure(principal.owner, projectId, {
                revision: Number(input.revision),
                write: input.write,
                recall: input.recall,
                model: modelPolicy(input.model),
              }),
            );
            return;
          }
          if (action === "memory-source" && !id && context.req.method === "GET") {
            const conversation = context.url.searchParams.get("conversation") ?? "";
            const message = context.url.searchParams.get("message") ?? "";
            if (![conversation, message].every((value) => /^[a-zA-Z0-9:_-]{1,128}$/u.test(value)))
              throw new HarnessError("invalidInput");
            const view = context.url.searchParams.get("view");
            if (view !== null && view !== "location") throw new HarnessError("invalidInput");
            respondJson(
              context.res,
              200,
              await (view === "location"
                ? options.memory.sourceLocation(principal.owner, projectId, conversation, message)
                : options.memory.sourceMessage(principal.owner, projectId, conversation, message)),
            );
            return;
          }
          if (action === "memory-terrain" && !id && context.req.method === "GET") {
            const topic = context.url.searchParams.get("topic") ?? undefined;
            const plate = context.url.searchParams.get("plate") ?? undefined;
            const place = context.url.searchParams.get("place") ?? undefined;
            const view = context.url.searchParams.get("view");
            const hops = context.url.searchParams.get("hops");
            if (
              (view !== null && view !== "overview" && view !== "timeline" && view !== "focus") ||
              (hops !== null && (view !== "focus" || (hops !== "1" && hops !== "2"))) ||
              [topic, plate, place].some((value) => value !== undefined && !/^[a-f0-9]{64}$/u.test(value))
            )
              throw new HarnessError("invalidInput");
            respondJson(
              context.res,
              200,
              await options.memory.terrain(principal.owner, projectId, topic, plate, {
                overview: view === "overview",
                timeline: view === "timeline",
                focus: view === "focus" ? (hops === "1" ? 1 : 2) : undefined,
                place,
              }),
            );
            return;
          }
          if (action !== "memory" || context.req.method !== "GET") throw new HarnessError("notFound", 404);
          if (id) {
            const rawBefore = context.url.searchParams.get("before");
            const before = rawBefore === null ? undefined : Number(rawBefore);
            if (rawBefore !== null && (!/^\d+$/u.test(rawBefore) || !Number.isSafeInteger(before) || before! < 1))
              throw new HarnessError("invalidInput");
            const detail = await options.memory.detail(principal.owner, projectId, id, before);
            respondJson(context.res, 200, { ...detail.current, ...detail });
            return;
          }
          const raw = context.url.searchParams.get("offset") ?? "0";
          const offset = Number(raw);
          if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(offset)) throw new HarnessError("invalidInput");
          const query = (context.url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 160);
          const [matches, index, materials] = await Promise.all([
            options.memory.find(principal.owner, projectId, query),
            options.memory.indexStatus(principal.owner, projectId),
            offset === 0 ? options.memory.findMaterials(principal.owner, projectId, query) : undefined,
          ]);
          const page = matches.slice(offset, offset + 40);
          respondJson(context.res, 200, {
            entries: page,
            index,
            materials,
            next: offset + page.length < matches.length ? offset + 40 : null,
          });
        } catch (error) {
          if (context.res.headersSent) {
            context.res.destroy();
            return;
          }
          if (error instanceof MemoryPackageError) {
            respondJson(context.res, 400, {
              messageId: error.messageId,
              error: error.messageId,
              code: "invalidPackage",
            });
            return;
          }
          const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
          const known =
            error instanceof HarnessError
              ? error
              : error instanceof RequestBodyError
                ? new HarnessError(error.status === 413 ? "contextTooLarge" : "invalidInput", error.status)
                : code === "notFound" || code === "forbidden" || errorStatus(error) === 404
                  ? new HarnessError("notFound", 404)
                  : code === "conflict" || errorStatus(error) === 409
                    ? new HarnessError("conflict", 409)
                    : new HarnessError("unavailable", 503);
          const messageId = `harness.error${known.code[0]!.toUpperCase()}${known.code.slice(1)}`;
          respondJson(context.res, known.status, { error: messageId, messageId, code: known.code });
        }
      },
    },
  ];
}
