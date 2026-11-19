import type { CreationConversationPage, CreationTaskDetail } from "../../shared/creation/contracts.js";

/** Pages describe one durable creation, including branches and legacy rounds with different artifact IDs. */
export class CreationConversationHistory {
  page: CreationConversationPage | null = null;
  nextCursor: string | null = null;
  private readonly ids = new Set<string>();
  reset() {
    this.page = null;
    this.nextCursor = null;
    this.ids.clear();
  }
  async load(
    page: CreationConversationPage,
    read: (id: string, signal?: AbortSignal) => Promise<{ task: CreationTaskDetail }>,
    cache: Map<string, { task: CreationTaskDetail; at: number }>,
    current: CreationTaskDetail,
    signal: AbortSignal,
    older = false,
  ) {
    const wanted = page.ids.filter(
      (id) =>
        id !== current.id &&
        (!cache.has(id) || ["queued", "running", "committing"].includes(cache.get(id)!.task.state)),
    );
    let offset = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, wanted.length) }, async () => {
        while (offset < wanted.length) {
          signal.throwIfAborted();
          const id = wanted[offset++]!,
            value = await read(id, signal);
          signal.throwIfAborted();
          if (value.task.id !== id || value.task.projectId !== current.projectId)
            throw new Error("Invalid creation round");
          cache.set(id, { task: value.task, at: Date.now() });
        }
      }),
    );
    signal.throwIfAborted();
    if (older || !this.page || !page.ids.some((id) => this.ids.has(id))) this.nextCursor = page.nextCursor;
    this.page = page;
    for (const id of page.ids) this.ids.add(id);
    this.ids.add(current.id);
    cache.set(current.id, { task: current, at: Date.now() });
    return [...this.ids]
      .map((id) => cache.get(id)?.task)
      .filter((task): task is CreationTaskDetail => !!task)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  snapshot() {
    return { page: this.page, nextCursor: this.nextCursor, ids: [...this.ids] };
  }
  restore(value: ReturnType<CreationConversationHistory["snapshot"]>) {
    if (!value?.page || !Array.isArray(value.ids)) return;
    this.page = value.page;
    this.nextCursor = value.nextCursor;
    for (const id of value.ids) if (typeof id === "string") this.ids.add(id);
  }
}
