import type { CreationTaskDetail } from "../../shared/creation/contracts.js";
import type { EngineItem } from "../../shared/engine/types.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { CreationCards } from "./cards.js";
import type { CreationWorkspaceBridge } from "./session-port.js";
import { creationRoundItems } from "./session-projection.js";

/** This view owns render signatures and DOM ordering; task and command state stay in the page model. */
export class CreationSessionPresenter {
  private readonly rendered = new Map<string, string>();
  constructor(
    private readonly bridge: Pick<CreationWorkspaceBridge, "render" | "preserve">,
    private readonly notice: HTMLElement,
    private readonly status: HTMLElement,
    private readonly t: Translate,
  ) {}
  clear() {
    this.rendered.clear();
  }
  render(task: CreationTaskDetail, rounds: CreationTaskDetail[], cards?: Pick<CreationCards, "render">) {
    this.bridge.preserve(() => {
      for (const round of rounds) {
        const turn = "creation-" + round.id;
        const projected = creationRoundItems(round, this.t),
          entries = projected.entries;
        this.message(projected.request, turn);
        for (const entry of entries) this.message(entry.item, turn);
        const stream = document.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn)}"] .turn-event-stream`);
        if (stream)
          for (const [index, entry] of entries.entries()) {
            const node = document.querySelector<HTMLElement>(
                `#conversation [data-item-id="${CSS.escape(String(entry.item.id))}"]`,
              ),
              before = stream.children[index] || null;
            if (node && before !== node) stream.insertBefore(node, before);
          }
      }
      const root = document.querySelector<HTMLElement>("#conversation")!;
      let anchor: ChildNode = this.notice;
      for (const round of rounds) {
        const turn = "creation-" + round.id;
        for (const node of [
          root.querySelector(`[data-item-id="${CSS.escape(turn + "-request")}"]`),
          root.querySelector(`[data-turn-id="${CSS.escape(turn)}"]`),
        ]) {
          if (!node || node.parentNode !== root) continue;
          if (anchor.nextSibling !== node) root.insertBefore(node, anchor.nextSibling);
          anchor = node;
        }
      }
      this.status.hidden = task.state === "replied";
      if (!this.status.hidden) cards?.render([task]);
      document.querySelector("#conversation")!.append(this.status);
    });
  }
  private message(item: EngineItem, turn: string) {
    const signature = JSON.stringify(item);
    if (this.rendered.get(String(item.id)) === signature) return;
    this.rendered.set(String(item.id), signature);
    this.bridge.render(item, turn);
  }
}
