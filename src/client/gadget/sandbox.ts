import { bootGadgetFrame } from "../../gadget/sdk/frame.js";
import type { GadgetComponent, GadgetContext } from "./contracts.js";
/** Extension UI receives a capability bridge and an opaque origin, never the live application DOM. */
export function sandboxGadget(source: string): GadgetComponent {
  return {
    mount(root, initial) {
      const frame = document.createElement("iframe");
      frame.className = "gadget-sandbox";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.referrerPolicy = "no-referrer";
      frame.title = initial.instance.title || initial.manifest.title.en;
      const nonce = crypto.randomUUID().replaceAll("-", "");
      const clean = (s: string) => s.replace(/<\/script/gi, "<\\/script");
      frame.srcdoc = `<!doctype html><html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>body{margin:0;color:var(--pf-ink);font:13px/1.6 system-ui;background:transparent}main{padding:14px}button{font:inherit;cursor:pointer}*{box-sizing:border-box}</style><body><script nonce="${nonce}">(${clean(bootGadgetFrame.toString())})();${clean(source)}</script></body></html>`;
      const channel = new MessageChannel();
      let context = initial,
        live = true,
        connected = false,
        initialized = false,
        inflight = 0;
      const readyTimer = setTimeout(() => {
        if (live && !connected) root.dispatchEvent(new CustomEvent("gadget-failed"));
      }, 15000);
      const update = (next: GadgetContext) => {
        context = next;
        if (!connected) return;
        const computed = getComputedStyle(document.documentElement),
          theme = Object.fromEntries(
            ["--pf-ink", "--pf-muted", "--pf-accent", "--pf-card", "--pf-canvas", "--pf-line", "--pf-soft"].map((k) => [
              k,
              computed.getPropertyValue(k).trim(),
            ]),
          );
        channel.port1.postMessage({
          type: "update",
          context: { config: next.instance.config, locale: next.locale, theme },
        });
      };
      channel.port1.onmessage = async (event) => {
        const d = event.data;
        if (!live || !d || typeof d !== "object") return;
        if (d.type === "connected") {
          clearTimeout(readyTimer);
          connected = true;
          update(context);
          return;
        }
        if (d.type === "failed") {
          root.dispatchEvent(new CustomEvent("gadget-failed"));
          return;
        }
        if (
          !["data", "action"].includes(d.type) ||
          !Number.isSafeInteger(d.id) ||
          typeof d.name !== "string" ||
          inflight >= 4
        )
          return;
        const names = d.type === "data" ? context.manifest.services : context.manifest.actions;
        if (!names.includes(d.name)) {
          channel.port1.postMessage({ type: "reply", id: d.id, error: "forbidden" });
          return;
        }
        inflight++;
        try {
          const value = await (d.type === "data" ? context.data(d.name, d.input) : context.action(d.name, d.input));
          if (live) channel.port1.postMessage({ type: "reply", id: d.id, value });
        } catch {
          if (live) channel.port1.postMessage({ type: "reply", id: d.id, error: "unavailable" });
        } finally {
          inflight--;
        }
      };
      channel.port1.start();
      frame.onload = () => {
        if (!live) return;
        if (initialized) {
          root.dispatchEvent(new CustomEvent("gadget-failed"));
          return;
        }
        initialized = true;
        frame.contentWindow?.postMessage({ type: "panda-gadget-init" }, "*", [channel.port2]);
      };
      root.append(frame);
      return {
        update,
        dispose() {
          live = false;
          clearTimeout(readyTimer);
          channel.port1.close();
          channel.port2.close();
          frame.onload = null;
          frame.remove();
        },
      };
    },
  };
}
