export interface FrameGadgetContext {
  locale: string;
  config: Record<string, string | number | boolean>;
  theme: Record<string, string>;
  signal: AbortSignal;
  data(name: string, input?: unknown): Promise<unknown>;
  action(name: string, input?: unknown): Promise<unknown>;
}
export interface FrameGadgetHandle {
  update(context: FrameGadgetContext): void | Promise<void>;
  dispose?(): void;
}
export type FrameGadgetRenderer = (
  root: HTMLElement,
  context: FrameGadgetContext,
) => FrameGadgetHandle | Promise<FrameGadgetHandle>;
/** Serialized into the sandbox before the extension entry, without giving it the parent application's globals. */
export function bootGadgetFrame() {
  let renderer: FrameGadgetRenderer | null = null,
    port: MessagePort | null = null,
    handle: FrameGadgetHandle | undefined,
    controller = new AbortController(),
    seq = 0,
    epoch = 0;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: unknown): void; timer: ReturnType<typeof setTimeout> }
  >();
  const root = document.createElement("main");
  document.body.append(root);
  Object.assign(window, {
    PandaGadget: {
      define(value: FrameGadgetRenderer) {
        if (renderer) throw Error("duplicateGadget");
        renderer = value;
      },
    },
  });
  function call(type: string, name: string, input: unknown) {
    return new Promise<unknown>((resolve, reject) => {
      if (!port || pending.size >= 4) {
        reject(Error("unavailable"));
        return;
      }
      const id = ++seq,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("unavailable"));
        }, 15000);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ type, name, input, id });
    });
  }
  window.addEventListener("pagehide", () => {
    controller.abort();
    epoch++;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(Error("unavailable"));
    }
    pending.clear();
    handle?.dispose?.();
    port?.close();
  });
  window.addEventListener("message", (event) => {
    if (port || event.source !== parent || event.data?.type !== "panda-gadget-init" || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = async (message) => {
      const data = message.data;
      if (data.type === "reply") {
        const item = pending.get(data.id);
        if (!item) return;
        clearTimeout(item.timer);
        pending.delete(data.id);
        data.error ? item.reject(Error(data.error)) : item.resolve(data.value);
        return;
      }
      if (data.type !== "update") return;
      if (!renderer) {
        port?.postMessage({ type: "failed" });
        return;
      }
      const ticket = ++epoch;
      controller.abort();
      controller = new AbortController();
      const context: FrameGadgetContext = {
        ...data.context,
        signal: controller.signal,
        data: (name, input) => call("data", name, input),
        action: (name, input) => call("action", name, input),
      };
      for (const [key, value] of Object.entries(context.theme))
        if (key.startsWith("--pf-")) document.documentElement.style.setProperty(key, value);
      document.documentElement.lang = context.locale;
      try {
        if (handle) await handle.update(context);
        else {
          const created = await renderer(root, context);
          if (ticket === epoch) {
            handle = created;
            await handle.update(context);
          } else created.dispose?.();
        }
        port?.postMessage({ type: "ready" });
      } catch {
        port?.postMessage({ type: "failed" });
      }
    };
    port.start();
    port.postMessage({ type: "connected" });
  });
}
/** A bundled extension calls this entry after the host initializes its sandbox runtime. */
export function defineGadget(renderer: FrameGadgetRenderer) {
  const runtime = (globalThis as typeof globalThis & { PandaGadget?: { define(value: FrameGadgetRenderer): void } })
    .PandaGadget;
  if (!runtime) throw Error("Gadget host unavailable");
  runtime.define(renderer);
}
