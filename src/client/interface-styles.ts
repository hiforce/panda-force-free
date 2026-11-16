import { request } from "./http-client.js";

let preparing: Promise<void> | undefined;
/** Recover a rejected stylesheet before revealing the workspace, preserving its URL base and integrity checks. */
export function prepareInterfaceStyles(): Promise<void> {
  return (preparing ??= recoverStyles().catch((reason) => {
    preparing = undefined;
    throw reason;
  }));
}
async function recoverStyles() {
  await Promise.all(
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-pf-asset-sha256]')].map(
      async (link) => {
        if (link.sheet) return;
        const url = new URL(link.href, location.href),
          expected = link.dataset.pfAssetSha256;
        if (url.origin !== location.origin || !/^[a-f0-9]{64}$/.test(expected || ""))
          throw Error("Invalid interface stylesheet");
        url.searchParams.set("recovery", "1");
        const response = await request(url, {
          credentials: "same-origin",
          cache: "reload",
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "text/css")
          throw Error("Interface stylesheet unavailable");
        const bytes = await response.arrayBuffer();
        const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
        if (actual !== expected) throw Error("Interface stylesheet version changed");
        const replacement = link.cloneNode(false) as HTMLLinkElement;
        replacement.href = url.href;
        replacement.dataset.pfRecoveredStyle = url.pathname;
        await new Promise<void>((resolve, reject) => {
          const finish = (reason?: Error) => {
            clearTimeout(timer);
            replacement.onload = null;
            replacement.onerror = null;
            if (reason) reject(reason);
            else resolve();
          };
          const timer = setTimeout(() => finish(Error("Interface stylesheet timed out")), 10000);
          replacement.onload = () => finish();
          replacement.onerror = () => finish(Error("Interface stylesheet unavailable"));
          link.replaceWith(replacement);
        });
      },
    ),
  );
}
