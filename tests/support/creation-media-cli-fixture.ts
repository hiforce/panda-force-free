#!/usr/bin/env bun
import { createHash } from "node:crypto";

const [operation] = process.argv.slice(2);
const request = await Bun.stdin.json();
const taskId = "fixture-task";
const outputId = "fixture-image";
const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAIAAAArjXluAAAAEElEQVR4nGP4z8AARAzYKAB3pAf53le34gAAAABJRU5ErkJggg==",
  "base64",
);
const emit = (value: object) => console.log(JSON.stringify(value));
if (operation === "version") {
  if (process.env.PANDA_MEDIA_API_KEY || process.env.PANDA_MEDIA_BASE_URL) emit({ error: "failed" });
  else emit({ protocol: "panda.media-cli/v1", version: "1.0.0" });
} else if (
  process.env.PANDA_MEDIA_API_KEY !== "fixture-secret" ||
  process.env.PANDA_MEDIA_BASE_URL !== "https://provider.invalid"
) {
  emit({ error: "authentication" });
} else if (operation === "check") {
  emit({ connected: true, capabilities: ["image.generate"] });
} else if (operation === "submit" && /^[a-f0-9]{64}$/.test(request.id) && request.kind === "image") {
  emit({ taskId });
} else if (operation === "status" && request.taskId === taskId) {
  emit({ taskId, state: "succeeded" });
} else if (operation === "cancel" && request.taskId === taskId) {
  emit({ taskId, state: "notCancellable" });
} else if (operation === "cancel" && request.taskId === "queued-fixture-task") {
  emit({ taskId: request.taskId, state: "cancelled" });
} else if (operation === "result" && request.taskId === taskId) {
  emit({
    taskId,
    outputs: [{ id: outputId, mime: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") }],
  });
} else if (
  operation === "download" &&
  request.taskId === taskId &&
  request.outputId === outputId &&
  request.outputFile === "result.media"
) {
  await Bun.write(request.outputFile, bytes);
  emit({ taskId, outputId, downloaded: true });
} else {
  emit({ error: "failed" });
}
