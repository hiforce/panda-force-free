import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { renderTemplatePreview } from "./render.js";
import { TEMPLATE_PREVIEW_RENDERER, type TemplatePreviewInput } from "../shared/template-previews/contracts.js";

const token = readFileSync(process.env.PANDA_FORCE_PREVIEW_TOKEN_FILE || "/run/panda-preview/token", "utf8").trim();
if (token.length < 32 || token.length > 256 || /\s/.test(token)) throw new Error("invalidPreviewToken");
const secret = Buffer.from("Bearer " + token);
let busy = false;
const server = createServer(async (req, res) => {
  const json = (status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };
  if (req.url === "/health" && req.method === "GET") return json(200, { renderer: TEMPLATE_PREVIEW_RENDERER });
  const supplied = Buffer.from(req.headers.authorization || "");
  if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
    req.resume();
    return json(401, { error: "unauthorized" });
  }
  if (req.url !== "/v1/render" || req.method !== "POST") {
    req.resume();
    return json(404, { error: "notFound" });
  }
  if (busy) {
    req.resume();
    return json(429, { error: "previewBusy" });
  }
  busy = true;
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 45 * 1024 * 1024) throw new Error("previewTooLarge");
      chunks.push(value);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as TemplatePreviewInput;
    json(200, await renderTemplatePreview(input));
  } catch {
    json(422, { error: "previewFailed" });
  } finally {
    busy = false;
  }
});
server.requestTimeout = 60000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PORT || "8901"), "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
