import type { CreationRequest } from "../../shared/creation/contracts.js";
import { defaultCreationOutput } from "../../shared/creation/default-output.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { CreationSessionDomain, SessionControlView } from "../contracts/session-workspace.js";
import { documentTreeApi } from "../documents/authoring/tree-api.js";
import { storage } from "../storage.js";
import { CreationApiError, creationApiFor } from "./api.js";
import type { CreationWorkspaceBridge } from "./session-port.js";
import type { CreationSessionState } from "./session-state.js";

export interface CommandPorts {
  t: Translate;
  api(): ReturnType<typeof creationApiFor>;
  controls(): SessionControlView;
  persist(): void;
  preferenceKey(): string;
  refresh(): Promise<void>;
  renderPending(): void;
  navigate(path: string): void;
  bridge: Pick<CreationWorkspaceBridge, "accepted" | "changed">;
}
/** Pending command identities survive failures and remain scoped to the page model. */
export class CreationSessionCommands {
  private destination?: {
    epoch: number;
    expiresAt: number;
    read: Promise<{ profileId: string; treeVersion: number; outputType: "auto" | "document" }>;
  };
  constructor(
    private readonly state: CreationSessionState,
    private readonly port: CommandPorts,
    private readonly defaultRuntime: () => Promise<string> | undefined,
  ) {}
  private readDestination() {
    const epoch = this.state.epoch;
    if (this.destination?.epoch === epoch && this.destination.expiresAt > Date.now()) return this.destination.read;
    const destination = {
      epoch,
      expiresAt: Infinity,
      read: Promise.all([this.port.api().options(), documentTreeApi.read("personal", AbortSignal.timeout(15000))]).then(
        ([options, tree]) => {
          if (!options.defaultProfileId) throw new Error(this.port.t("creation.unavailable"));
          return {
            profileId: options.defaultProfileId,
            treeVersion: tree.version,
            outputType: defaultCreationOutput(options),
          };
        },
      ),
    };
    this.destination = destination;
    void destination.read.then(
      () => (destination.expiresAt = Date.now() + 15000),
      () => {
        if (this.destination === destination) this.destination = undefined;
      },
    );
    return destination.read;
  }
  warmDestination() {
    void this.readDestination();
  }
  async submit(input: Parameters<CreationSessionDomain["submit"]>[0]) {
    const route = this.state.route,
      epoch = this.state.epoch;
    if (!route || this.state.sending.has(route.key)) return;
    const prompt = input.text || this.port.t("creation.attachmentBrief");
    const attachments = input.attachments.map((attachment) => ({ materialId: attachment.materialId! }));
    if (this.state.pending) {
      const request = this.state.pending.request;
      if (
        request.prompt !== prompt ||
        JSON.stringify(request.attachments) !== JSON.stringify(attachments) ||
        JSON.stringify(request.selections) !== JSON.stringify(input.selections)
      ) {
        this.port.renderPending();
        throw new Error(this.port.t("creation.pendingSubmission"));
      }
    }
    await this.whileSending(route.key, async () => {
      if (!this.state.pending) {
        const control = this.port.controls(),
          id = crypto.randomUUID(),
          locale = document.documentElement.lang || "en";
        const [runtimeId, target] = await Promise.all([
          control.runtimeId || this.defaultRuntime(),
          route.id
            ? this.state.task?.artifact && this.state.task.state === "succeeded"
              ? this.port
                  .api()
                  .options()
                  .then((options) => ({ outputType: defaultCreationOutput(options) }))
              : undefined
            : this.readDestination().then((destination) => ({
                ...destination,
                projectId: "personal",
                parentId: null,
                locale,
              })),
        ]);
        if (epoch !== this.state.epoch) return;
        this.state.pending = {
          id,
          request: {
            id,
            prompt,
            selections: [...input.selections],
            attachments,
            dialogue: true,
            ...(runtimeId ? { runtimeId } : {}),
            ...(control.model ? { model: control.model } : {}),
            ...(control.effort ? { effort: control.effort } : {}),
            ...target,
          },
        };
        this.port.persist();
      }
      await this.dispatch();
    });
  }

  async dispatchPending() {
    const route = this.state.route;
    if (route && this.state.pending) await this.whileSending(route.key, () => this.dispatch());
  }

  private async whileSending(key: string, work: () => Promise<void>) {
    if (this.state.sending.has(key)) return;
    this.state.sending.add(key);
    try {
      this.port.renderPending();
      await work();
    } finally {
      this.state.sending.delete(key);
      if (this.state.route?.key === key) this.port.renderPending();
    }
  }

  private async dispatch() {
    const route = this.state.route,
      pending = this.state.pending,
      epoch = this.state.epoch;
    if (!route || !pending) return;
    const key = this.port.preferenceKey(),
      model = this.state.model,
      effort = this.state.effort,
      api = this.port.api();
    const clearPending = () => {
      const saved = storage.getJson(key, { model, effort, pending: null });
      if (saved.pending?.id === pending.id) storage.setJson(key, { ...saved, pending: null });
    };
    try {
      const request = { ...pending.request, id: pending.id };
      if ("runtimeId" in request && request.runtimeId === "") Reflect.deleteProperty(request, "runtimeId");
      const result = route.id
        ? await api.message(this.state.task?.id || route.id, request)
        : await api.submit(request as CreationRequest);
      clearPending();
      if (epoch === this.state.epoch && this.state.pending?.id === pending.id) this.state.pending = undefined;
      const materials = (pending.request.attachments || []) as readonly { materialId: string }[];
      this.port.bridge.accepted(
        route.key,
        `creation:${route.scope}:${result.task.id}`,
        String(pending.request.prompt),
        materials.map((entry) => entry.materialId),
      );
      if (epoch !== this.state.epoch) return;
      if (result.task.id === route.id) void this.port.refresh();
      else this.port.navigate("/creation/" + encodeURIComponent(result.task.id) + "?creationScope=" + route.scope);
    } catch (error) {
      if (
        error instanceof CreationApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      ) {
        clearPending();
        if (epoch === this.state.epoch && this.state.pending?.id === pending.id) this.state.pending = undefined;
        if (this.destination?.epoch === epoch) this.destination = undefined;
      }
      throw error;
    }
  }
}
