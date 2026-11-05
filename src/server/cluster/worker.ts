import { stableJson } from "../../shared/stable-json.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isRecord } from "../../shared/records.js";
import type { ClusterConfig } from "./config.js";
import type { CoordinationStore, JournalEvent, OwnerLease } from "./contracts.js";
import { ClusterError } from "./contracts.js";
import { createPostgresCoordination } from "./postgres.js";
import { verifyRequestBody } from "../request-bytes.js";
import { requestDigest, verifyClusterHead } from "./signing.js";

const READS = new Set([
  "model/list",
  "permissionProfile/list",
  "account/read",
  "account/rateLimits/read",
  "thread/list",
  "thread/loaded/list",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/goal/get",
  "thread/queue/list",
  "host/thread/live",
  "host/thread/history",
]);
export interface ClusterWorker {
  readonly lease: OwnerLease;
  assertOwner(): void;
  verify(request: IncomingMessage, upgrade?: boolean): Promise<void>;
  dispatch(
    input: unknown,
    execute: (input: unknown) => Promise<unknown>,
    validate?: (input: unknown) => void,
  ): Promise<unknown>;
  publish(data: object, deliver: (data: object, event?: JournalEvent) => void): void;
  replay(cursor: string): Promise<JournalEvent[]>;
  connectEvents(cursor: string, accept: (events: JournalEvent[], resync: boolean) => void): Promise<void>;
  close(engineStopped: boolean): Promise<void>;
}

/** A workspace has one fenced engine owner. Gateways never open its local database or CLI. */
export async function createClusterWorker(
  config: ClusterConfig,
  onLost: () => void,
  store: CoordinationStore = createPostgresCoordination(config.databaseUrl),
): Promise<ClusterWorker> {
  if (config.role !== "worker" || !config.nodeUrl) throw new Error("Cluster worker requires an owner address");
  let lease: OwnerLease;
  const started = performance.now();
  try {
    await store.initialize();
    lease = await store.claimOwner({
      workspace: config.workspace,
      nodeId: config.nodeId,
      bootId: randomUUID(),
      address: config.nodeUrl!,
      leaseMs: config.leaseMs,
      recoverFence: config.recoverFence,
    });
  } catch (error) {
    await store.close();
    throw error;
  }
  let deadline = started + Math.min(config.leaseMs, lease.expiresAt - lease.databaseNow),
    lost = false,
    closing = false,
    renewing = false;
  let queuedBytes = 0,
    journal = Promise.resolve();
  const fence = () => {
    if (lost || closing) return;
    lost = true;
    console.error(
      "[PandaForce] cluster/owner-fenced",
      JSON.stringify({ workspace: config.workspace, nodeId: config.nodeId, fence: lease.fence }),
    );
    onLost();
  };
  const assertOwner = () => {
    if (lost || closing || performance.now() >= deadline) {
      fence();
      throw new ClusterError("Workspace owner is unavailable", "cluster_owner_unavailable");
    }
  };
  let nextRenewal = performance.now() + Math.floor(config.leaseMs / 3);
  const timer = setInterval(
    async () => {
      if (lost || closing) return;
      if (performance.now() >= deadline) {
        fence();
        return;
      }
      if (renewing || performance.now() < nextRenewal) return;
      renewing = true;
      const begin = performance.now();
      try {
        assertOwner();
        lease = await store.renew(lease, config.leaseMs);
        deadline = begin + Math.min(config.leaseMs, lease.expiresAt - lease.databaseNow);
        assertOwner();
        nextRenewal = performance.now() + Math.floor(config.leaseMs / 3);
      } catch {
        fence();
      } finally {
        renewing = false;
      }
    },
    Math.min(1000, Math.floor(config.leaseMs / 6)),
  );
  timer.unref();
  async function replay(cursor: string): Promise<JournalEvent[]> {
    assertOwner();
    const match = /^(\d+):(\d+)$/.exec(cursor);
    if (!match || Number(match[1]) !== lease.fence || !Number.isSafeInteger(Number(match[2]))) return [];
    const result: JournalEvent[] = [];
    let sequence = Number(match[2]);
    for (let page = 0; page < 10; page++) {
      const events = await store.readEvents(config.workspace, lease.fence, sequence, 500);
      result.push(...events);
      if (events.length < 500) break;
      sequence = events.at(-1)!.sequence;
    }
    return result;
  }
  return {
    get lease() {
      return lease;
    },
    assertOwner,
    async verify(request, upgrade = false) {
      assertOwner();
      const { nonce, digest } = verifyClusterHead(config, lease, {
        method: request.method || "GET",
        path: request.url || "/",
        headers: request.headers,
      });
      if (upgrade || ["GET", "HEAD"].includes(request.method || "GET")) {
        if (digest !== requestDigest(Buffer.alloc(0)))
          throw new ClusterError("Unexpected internal request body", "cluster_request_rejected", 403);
      } else
        verifyRequestBody(request, (body) => {
          assertOwner();
          if (requestDigest(body) !== digest)
            throw new ClusterError("Internal body signature did not match", "cluster_request_rejected", 403);
        });
      if (!(await store.acceptNonce(lease, nonce)))
        throw new ClusterError("Internal request has already been used", "cluster_request_replayed", 409);
      assertOwner();
    },
    async dispatch(input, execute, validate) {
      assertOwner();
      // Definitively invalid answers must not reserve a durable command identity.
      validate?.(input);
      if (
        !isRecord(input) ||
        input.type === "ping" ||
        (input.type === "rpc" && typeof input.method === "string" && READS.has(input.method))
      )
        return execute(input);
      const approval = ["engine/response", "engine/error", "codex/response", "codex/error"].includes(
        String(input.type),
      );
      const operationId = approval
        ? "approval:" + lease.fence + ":" + typeof input.requestId + ":" + String(input.requestId)
        : typeof input.operationId === "string" && /^[\da-f-]{36}$/i.test(input.operationId)
          ? input.operationId
          : randomUUID();
      // An approval is an exclusive decision: the first validated answer wins across wire versions.
      const digest = requestDigest(
        stableJson(
          approval ? { requestId: input.requestId } : { type: input.type, method: input.method, params: input.params },
        ),
      );
      const claim = await store.beginOperation(lease, operationId, digest);
      if (claim.kind === "conflict")
        throw new ClusterError(
          "This request identity already belongs to a different operation",
          "cluster_operation_conflict",
          409,
        );
      if (claim.kind === "uncertain")
        throw Object.assign(
          new ClusterError(
            "The previous result is uncertain. Check the session before submitting again.",
            "cluster_delivery_uncertain",
            409,
          ),
          { deliveryUncertain: true },
        );
      if (claim.kind === "completed") {
        // RPC identity is connection-local; the persisted command result is not.
        return isRecord(claim.result) ? { ...claim.result, id: input.id } : claim.result;
      }
      assertOwner();
      const result = await execute(input);
      try {
        await store.completeOperation(lease, operationId, digest, result);
      } catch {
        fence();
        throw Object.assign(
          new ClusterError("The operation result could not be confirmed", "cluster_delivery_uncertain"),
          { deliveryUncertain: true },
        );
      }
      return result;
    },
    publish(data, deliver) {
      if (lost || closing) return;
      if (performance.now() >= deadline) {
        fence();
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(data));
      queuedBytes += bytes;
      if (queuedBytes > 64 * 1024 * 1024) {
        fence();
        return;
      }
      journal = journal
        .then(async () => {
          assertOwner();
          const event = await store.appendEvent(lease, data);
          deliver(data, event);
        })
        .catch(() => {
          fence();
        })
        .finally(() => {
          queuedBytes -= bytes;
        });
    },
    replay,
    async connectEvents(cursor, accept) {
      let failure: unknown;
      journal = journal
        .then(async () => {
          const events = await replay(cursor);
          const resync =
            Boolean(cursor) &&
            (!/^\d+:\d+$/.test(cursor) ||
              !Number.isSafeInteger(Number(cursor.split(":")[1])) ||
              !cursor.startsWith(lease.fence + ":") ||
              events.length === 5000);
          accept(events, resync);
        })
        .catch((error: unknown) => {
          failure = error;
          fence();
        });
      await journal;
      if (failure) throw failure;
    },
    async close(engineStopped) {
      await journal;
      closing = true;
      clearInterval(timer);
      if (engineStopped) await store.release(lease);
      await store.close();
    },
  };
}
