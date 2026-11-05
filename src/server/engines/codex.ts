import { stableJson } from "../../shared/stable-json.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { engineQuestions, validateQuestionAnswers, type EngineQuestion } from "../../shared/engine/questions.js";
import type { EngineDriver, EngineEnvelope, EngineEvent, EngineOperation } from "../../shared/engine/contracts.js";
import type { ApprovalModel } from "../../shared/data-contracts.js";
import type { RpcId } from "../../shared/rpc-types.js";
import { ENGINE_OPERATIONS, isEngineOperation } from "../../shared/engine/operations.js";
import { approvalDecisionResponse, buildApprovalModel, normalizeApprovalRequest } from "../../shared/codex-surfaces.js";
import { isRecord } from "../../shared/records.js";
import { createCodexBridge } from "../bridge/codex-process.js";
import type { CodexConnection, CodexTransportFactory } from "./codex-transport.js";
import { engineSession } from "./session-codec.js";

export interface CodexDriverOptions {
  connection: CodexConnection;
  defaultCwd: string;
  version: string;
  isShuttingDown(): boolean;
}
/** Codex transport, native approval choices and lifecycle live behind one driver. */
export function createCodexDriver(
  options: CodexDriverOptions,
  transportFactory: CodexTransportFactory = createCodexBridge,
): EngineDriver {
  const pendingRequests = new Map<RpcId, RpcId>();
  const nativeRequests = new Map<RpcId, string>();
  const listeners = new Set<(event: EngineEvent) => void>();
  const questionnaires = new Map<RpcId, EngineQuestion[]>();
  const approvals = new Map<RpcId, { request: EngineEnvelope; model: ApprovalModel }>();
  const emit = (event: EngineEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const descriptor = Object.freeze({
    id: "codex",
    name: "Codex",
    kind: "conversation" as const,
    protocolVersion: 1 as const,
    capabilities: Object.freeze([
      "sessions",
      "input",
      "streaming",
      "approvals",
      "questions",
      "models",
      "account",
      "usage",
      "permissions",
      "goals",
      "queue",
      "review",
    ] as const),
  });
  const bridge = transportFactory({
    connection: options.connection,
    defaultCwd: options.defaultCwd,
    clientInfo: { name: "panda-force", title: "PandaForce", version: options.version },
    isShuttingDown: options.isShuttingDown,
    onConnected: (info) =>
      emit({
        kind: "connected",
        engineId: descriptor.id,
        info,
        ...(isRecord(info) && typeof info.codexHome === "string"
          ? { storage: { sessionsRoot: resolve(info.codexHome, "sessions") } }
          : {}),
      }),
    onDisconnected: (code, signal) => {
      approvals.clear();
      questionnaires.clear();
      pendingRequests.clear();
      nativeRequests.clear();
      emit({ kind: "disconnected", engineId: descriptor.id, code, signal });
    },
    onMessage: (input) => {
      if (input.id !== undefined && input.method) {
        const publicId = nativeRequests.get(input.id) || randomUUID();
        nativeRequests.set(input.id, publicId);
        let envelope: EngineEnvelope & { id: RpcId } = { ...input, id: publicId };
        if (
          [
            "execCommandApproval",
            "applyPatchApproval",
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
          ].includes(input.method)
        ) {
          const request: EngineEnvelope = normalizeApprovalRequest(input);
          const model = buildApprovalModel(request);
          approvals.set(publicId, { request, model });
          const choice = (name: "primary" | "deny" | "leading" | "scoped") =>
            model[name] ? { ...model[name], decision: { choiceId: name } } : null;
          envelope = {
            ...request,
            id: publicId,
            surface: {
              kind: "approval",
              model: {
                ...model,
                primary: { ...model.primary, decision: { choiceId: "primary" } },
                deny: { ...model.deny, decision: { choiceId: "deny" } },
                leading: choice("leading"),
                scoped: choice("scoped"),
                cancel: { choiceId: "cancel" },
              },
            },
          };
        }
        if (["item/tool/requestUserInput", "tool/requestUserInput"].includes(input.method)) {
          try {
            const questions = engineQuestions(input.params?.questions);
            questionnaires.set(publicId, questions);
            envelope = { ...envelope, surface: { kind: "questions", questions } };
          } catch {
            bridge.sendRaw({ id: input.id, error: { code: -32602, message: "Invalid engine questionnaire" } });
            return;
          }
        }
        pendingRequests.set(publicId, input.id);
        emit({ kind: "approval", engineId: descriptor.id, envelope });
      } else {
        if (input.method === "serverRequest/resolved" && input.params?.requestId !== undefined) {
          const publicId = nativeRequests.get(input.params.requestId);
          if (publicId) {
            approvals.delete(publicId);
            questionnaires.delete(publicId);
            pendingRequests.delete(publicId);
            nativeRequests.delete(input.params.requestId);
            input = { ...input, params: { ...input.params, requestId: publicId } };
          }
        }
        emit({ kind: "notification", engineId: descriptor.id, envelope: input });
      }
    },
  });
  const execute = (operation: EngineOperation, params: Record<string, unknown> = {}) => {
    if (!isEngineOperation(operation)) throw new Error("Unsupported engine operation");
    return bridge.request(ENGINE_OPERATIONS[operation].rpc, params);
  };
  async function session(
    operation: "session.read" | "session.create" | "session.resume",
    params: Record<string, unknown>,
  ) {
    const result = await execute(operation, params);
    if (!isRecord(result)) throw new Error("Invalid engine session response");
    return engineSession(result.thread);
  }
  function prepareResponse(id: RpcId, result?: unknown, error?: unknown) {
    if (!pendingRequests.has(id)) throw new Error("Engine request is no longer pending");
    if (error === undefined && questionnaires.has(id)) validateQuestionAnswers(questionnaires.get(id)!, result);
    const pending = approvals.get(id);
    if (pending && error === undefined) {
      let key = isRecord(result) && typeof result.choiceId === "string" ? result.choiceId : "";
      if (!key) {
        // Older clients may submit a native v1 result, but only a displayed choice can match.
        const encoded = stableJson(result);
        for (const name of ["primary", "deny", "leading", "scoped"] as const) {
          const candidate = pending.model[name];
          if (
            candidate &&
            encoded === stableJson(approvalDecisionResponse(pending.request, candidate.decision, pending.model.kind))
          ) {
            key = name;
            break;
          }
        }
      }
      if (!key) throw new Error("Choose a displayed approval option");
      const selection =
        key === "cancel"
          ? pending.model.cancel
          : ["primary", "deny", "leading", "scoped"].includes(key)
            ? Reflect.get(pending.model, key)
            : null;
      if (key !== "cancel" && !isRecord(selection)) throw new Error("Approval option is unavailable");
      result = approvalDecisionResponse(
        pending.request,
        key === "cancel" ? selection : isRecord(selection) ? selection.decision : null,
        pending.model.kind,
      );
    }
    return result;
  }
  return {
    descriptor,
    sessions: {
      async list(options = {}) {
        const result = await execute("session.list", options);
        if (!isRecord(result) || !Array.isArray(result.data)) throw new Error("Invalid engine session page");
        return {
          sessions: result.data.map(engineSession),
          nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
        };
      },
      read: (id) => session("session.read", { threadId: id, includeTurns: true }),
      create: (options = {}) => session("session.create", options),
      resume: (id) => session("session.resume", { threadId: id }),
    },
    get connected() {
      return bridge.connected;
    },
    execute,
    validateResponse(id, result, error) {
      prepareResponse(id, result, error);
    },
    respond(id, result, error) {
      result = prepareResponse(id, result, error);
      const nativeId = pendingRequests.get(id)!;
      bridge.sendRaw(error === undefined ? { id: nativeId, result } : { id: nativeId, error });
      nativeRequests.delete(nativeId);
      pendingRequests.delete(id);
      approvals.delete(id);
      questionnaires.delete(id);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: bridge.start,
    stop: bridge.terminate,
    fullyStopped: bridge.fullyStopped,
    cancelRestart: bridge.cancelRestart,
    rejectPending: bridge.rejectPending,
  };
}
