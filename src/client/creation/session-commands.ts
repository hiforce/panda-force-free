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
  constructor(
    private readonly state: CreationSessionState,
    private readonly port: CommandPorts,
  ) {}
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
    } else {
      const control = this.port.controls(),
        id = crypto.randomUUID();
      const request = {
        id,
        prompt,
        selections: [...input.selections],
        attachments,
        runtimeId: control.runtimeId,
        ...(control.model ? { model: control.model } : {}),
        ...(control.effort ? { effort: control.effort } : {}),
      };
      if (route.id) {
        this.state.sending.add(route.key);
        try {
          const outputType =
            this.state.task?.artifact && this.state.task.state === "succeeded"
              ? defaultCreationOutput(await this.port.api().options())
              : undefined;
          if (epoch !== this.state.epoch) return;
          this.state.pending = { id, request: { ...request, ...(outputType ? { outputType } : {}) } };
        } finally {
          this.state.sending.delete(route.key);
        }
      } else {
        this.state.sending.add(route.key);
        try {
          const [options, tree] = await Promise.all([this.port.api().options(), documentTreeApi.read("personal")]);
          if (epoch !== this.state.epoch) return;
          if (!options.defaultProfileId) throw new Error(this.port.t("creation.unavailable"));
          this.state.pending = {
            id,
            request: {
              ...request,
              projectId: "personal",
              treeVersion: tree.version,
              parentId: null,
              locale: document.documentElement.lang,
              profileId: options.defaultProfileId,
              outputType: defaultCreationOutput(options),
            },
          };
        } finally {
          this.state.sending.delete(route.key);
        }
      }
      this.port.persist();
    }
    await this.dispatchPending();
  }

  async dispatchPending() {
    const route = this.state.route,
      pending = this.state.pending,
      epoch = this.state.epoch;
    if (!route || !pending || this.state.sending.has(route.key)) return;
    const key = this.port.preferenceKey(),
      model = this.state.model,
      effort = this.state.effort,
      api = this.port.api();
    const clearPending = () => {
      const saved = storage.getJson(key, { model, effort, pending: null });
      if (saved.pending?.id === pending.id) storage.setJson(key, { ...saved, pending: null });
    };
    this.state.sending.add(route.key);
    this.port.renderPending();
    try {
      const result = route.id
        ? await api.message(this.state.task?.id || route.id, { ...pending.request, id: pending.id })
        : await api.submit(pending.request as CreationRequest);
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
      this.port.renderPending();
      if (result.task.id === route.id) await this.port.refresh();
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
      }
      if (epoch === this.state.epoch) this.port.renderPending();
      throw error;
    } finally {
      this.state.sending.delete(route.key);
    }
  }
}
