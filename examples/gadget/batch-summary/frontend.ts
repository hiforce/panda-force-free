import { defineGadget, type FrameGadgetContext } from "../../../src/gadget/sdk/frame.js";
const labels = {
  en: { progress: "Processed", open: "Open tasks", error: "Could not load this batch" },
  "zh-CN": { progress: "已处理", open: "查看任务", error: "暂时无法加载此批次" },
  "zh-HK": { progress: "已處理", open: "查看任務", error: "暫時無法載入此批次" },
  "zh-TW": { progress: "已處理", open: "查看任務", error: "暫時無法載入此批次" },
};
defineGadget((root, initial) => {
  let context = initial,
    epoch = 0;
  const heading = document.createElement("strong"),
    value = document.createElement("p"),
    button = document.createElement("button");
  root.append(heading, value, button);
  button.onclick = () => void context.action("open");
  async function update(next: FrameGadgetContext) {
    context = next;
    const ticket = ++epoch,
      text = labels[next.locale as keyof typeof labels] || labels.en;
    heading.textContent = String(next.config.batch);
    button.textContent = text.open;
    try {
      const summary = (await next.data("summary")) as { processed: number; total: number };
      if (ticket !== epoch || next.signal.aborted) return;
      value.textContent = `${text.progress}: ${summary.processed} / ${summary.total}`;
    } catch {
      if (ticket === epoch && !next.signal.aborted) value.textContent = text.error;
    }
  }
  return {
    update,
    dispose() {
      epoch++;
      button.onclick = null;
      root.replaceChildren();
    },
  };
});
