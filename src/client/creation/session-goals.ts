import type { CreationSessionDomain } from "../contracts/session-workspace.js";
import { storage } from "../storage.js";
import { CreationApiError } from "./api.js";
import type { CommandPorts } from "./session-commands.js";
import type { CreationSessionState } from "./session-state.js";
/** Goal commands fence concurrent reads and retain uncertain command IDs in the page model. */
export class CreationSessionGoals {
  constructor(
    private readonly state: CreationSessionState,
    private readonly port: Pick<
      CommandPorts,
      "t" | "api" | "controls" | "preferenceKey" | "renderPending" | "bridge" | "navigate" | "refresh"
    >,
  ) {}
  private get key() {
    return this.state.route?.key || "";
  }
  goal(): import("../../shared/engine/types.js").Goal | null {
    const goal = this.state.task?.goal;
    return goal
      ? {
          threadId: this.key,
          goalId: goal.id,
          objective: goal.objective,
          status: goal.status,
          updatedAt: goal.updatedAt,
          detail: this.port.t("creation.goalScope"),
          progress: { completed: goal.status === "completed" ? 1 : 0, total: 1 },
        }
      : null;
  }
  async goalCommand(command: Parameters<CreationSessionDomain["goalCommand"]>[0]) {
    const route = this.state.route,
      task = this.state.task,
      epoch = this.state.epoch;
    if (!route?.id || !task) throw new Error(this.port.t("workbench.startATaskFirst"));
    if (this.state.goalWriting) throw new Error(this.port.t("creation.goalPending"));
    if (
      this.state.pendingGoal &&
      (command.action !== this.state.pendingGoal.action || command.objective !== this.state.pendingGoal.objective)
    )
      throw new Error(this.port.t("creation.goalPending"));
    const controls = this.port.controls();
    const request = this.state.pendingGoal || {
      id: crypto.randomUUID(),
      ...command,
      ...(["set", "create"].includes(command.action)
        ? { runtimeId: controls.runtimeId, model: controls.model || undefined, effort: controls.effort || undefined }
        : {}),
    };
    this.state.pendingGoal = request;
    const key = this.port.preferenceKey() + ":goal";
    storage.setJson(key, request);
    this.state.goalWriting = true;
    this.port.renderPending();
    const clear = () => {
      if (storage.getJson(key, null)?.id === request.id) storage.remove(key);
      if (epoch === this.state.epoch) this.state.pendingGoal = undefined;
    };
    try {
      const result = await this.port.api().goal(this.state.task?.id || route.id, request);
      clear();
      if (epoch !== this.state.epoch) return null;
      this.state.goalRevision++;
      this.port.renderPending();
      if (result.task.id !== route.id) {
        this.port.bridge.accepted(route.key, `creation:${route.scope}:${result.task.id}`, "", []);
        this.port.navigate("/creation/" + encodeURIComponent(result.task.id) + "?creationScope=" + route.scope);
        return null;
      }
      this.state.task = { ...task, ...result.task, goal: result.goal };
      this.port.bridge.changed();
      void this.port.refresh();
      return this.goal();
    } catch (error) {
      if (
        error instanceof CreationApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      )
        clear();
      throw error;
    } finally {
      if (epoch === this.state.epoch) {
        this.state.goalWriting = false;
        this.port.renderPending();
        this.port.bridge.changed();
      }
    }
  }
}
