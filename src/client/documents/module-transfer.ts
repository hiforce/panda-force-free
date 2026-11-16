import { request } from "../http-client.js";

/** Fetch warming avoids poisoning the browser's module map when a download fails before evaluation. */
export async function prepareDocumentModule(url: string): Promise<void> {
  const response = await request(url, {
    credentials: "same-origin",
    cache: new URL(url, location.href).origin === location.origin ? "no-cache" : "force-cache",
    signal: AbortSignal.timeout(30000),
  });
  const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    !response.ok ||
    !["text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"].includes(mime || "")
  ) {
    await response.body?.cancel();
    throw new Error("Runtime transfer failed");
  }
  if (!(await response.arrayBuffer()).byteLength) throw new Error("Runtime transfer was empty");
}
