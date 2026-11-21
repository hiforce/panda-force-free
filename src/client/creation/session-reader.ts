import type { CreationTaskDetail } from "../../shared/creation/contracts.js";
import { creationActive } from "./activity.js";
import type { creationApiFor } from "./api.js";
import type { CreationSessionState } from "./session-state.js";

interface ReadPorts {
  api(): ReturnType<typeof creationApiFor>;
  present(task: CreationTaskDetail, rounds: CreationTaskDetail[]): void;
  cache(task: CreationTaskDetail, rounds: CreationTaskDetail[]): void;
  paintEarlier(): void;
  failed(error: unknown): void;
  hidden(): boolean;
}
/** Serial reads use the same epoch and goal revision as commands; stale finalizers never restart polling. */
export class CreationSessionReader {
  constructor(
    private readonly state: CreationSessionState,
    private readonly port: ReadPorts,
  ) {}
  private get running() {
    return Boolean(this.state.task && creationActive(this.state.task));
  }
  async refresh() {
    if (!this.state.route?.id || this.state.reading || this.state.historyLoading) return;
    const epoch = this.state.epoch,
      id = this.state.route.id,
      api = this.port.api(),
      goalRevision = this.state.goalRevision;
    this.state.reading = true;
    clearTimeout(this.state.timer);
    try {
      const signal = this.state.historyController.signal;
      const page =
        !this.state.conversation.page || Date.now() - this.state.historyCheckedAt >= 10000
          ? await api.rounds(id, undefined, signal)
          : null;
      if (page) this.state.historyCheckedAt = Date.now();
      const { task } = await api.detail(page?.latestTaskId || this.state.task?.id || id, signal);
      task.creation = page?.creation || this.state.task?.creation || this.state.conversation.page?.creation;
      if (this.state.task && this.state.task.state !== task.state) this.state.historyCheckedAt = 0;
      if (epoch !== this.state.epoch || goalRevision !== this.state.goalRevision) return;
      this.port.present(
        task,
        [...this.state.previous.values()]
          .map((value) => value.task)
          .filter((value) => value.id !== task.id)
          .concat(task)
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
      );
      const rounds = page
        ? await this.state.conversation.load(page, api.detail, this.state.previous, task, signal)
        : [...this.state.previous.values()]
            .map((value) => value.task)
            .filter((value) => value.id !== task.id)
            .concat(task)
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      if (epoch !== this.state.epoch || goalRevision !== this.state.goalRevision) return;
      this.port.present(task, rounds);
      this.port.cache(task, rounds);
      this.port.paintEarlier();
    } catch (error) {
      if (epoch !== this.state.epoch) return;
      this.port.failed(error);
    } finally {
      if (epoch === this.state.epoch) {
        this.state.reading = false;
        this.port.paintEarlier();
        this.state.timer = setTimeout(
          () => void this.refresh(),
          this.port.hidden() ? 10000 : this.running ? 1500 : 10000,
        );
      }
    }
  }

  async loadEarlier() {
    const cursor = this.state.conversation.nextCursor,
      route = this.state.route,
      current = this.state.task,
      epoch = this.state.epoch;
    if (!cursor || !route?.id || !current || this.state.historyLoading || this.state.reading) return;
    this.state.historyLoading = true;
    this.state.historyFailed = false;
    this.port.paintEarlier();
    try {
      const signal = this.state.historyController.signal,
        page = await this.port.api().rounds(route.id, cursor, signal);
      if (page.latestTaskId !== this.state.task!.id) this.state.historyCheckedAt = 0;
      this.state.task!.creation = page.creation;
      const rounds = await this.state.conversation.load(
        page,
        this.port.api().detail,
        this.state.previous,
        this.state.task!,
        signal,
        true,
      );
      if (epoch !== this.state.epoch) return;
      this.port.present(this.state.task!, rounds);
      this.port.cache(this.state.task!, rounds);
    } catch {
      if (epoch === this.state.epoch) this.state.historyFailed = true;
    } finally {
      if (epoch === this.state.epoch) {
        this.state.historyLoading = false;
        this.port.paintEarlier();
        void this.refresh();
      }
    }
  }
}
