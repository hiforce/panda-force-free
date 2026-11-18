import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { FilePackageContent } from "../../packages/content-store.js";
import type { CreationArtifactWriter, CreationOutputContent } from "../ports.js";
import { CreationError, type CreationTaskSpec } from "../contracts.js";
import { creationDigest, creationRecord, creationText, creationUuid } from "../validation.js";

const rendered = Symbol("application-rendered-output");
/** JSON document arguments cannot mint the trusted media channel. */
export function renderedCreationOutput(value: unknown) {
  return { [rendered]: true, value };
}
function mediaValue(value: unknown): { value: unknown } | null {
  return value !== null &&
    typeof value === "object" &&
    rendered in value &&
    value[rendered] === true &&
    "value" in value
    ? { value: value.value }
    : null;
}
interface Route {
  owner: string;
  taskId: string;
  digest: string;
  channel: "document" | "media";
}
const hash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const key = ({ owner, taskId, digest }: Omit<Route, "channel">) =>
  hash({ purpose: "creation-output-route", owner, taskId, digest });
function route(value: unknown): Route {
  const row = creationRecord(value, ["owner", "taskId", "digest", "channel"]);
  if (row.channel !== "document" && row.channel !== "media") throw new CreationError("invalidInput");
  return {
    owner: creationText(row.owner, 200),
    taskId: creationUuid(row.taskId),
    digest: creationDigest(row.digest),
    channel: row.channel,
  };
}
/** Persist the channel before admission so restart recovery never guesses from model JSON or current capabilities. */
export class TypedCreationOutput implements CreationOutputContent, CreationArtifactWriter {
  private readonly routes: FilePackageContent<Route>;
  constructor(
    root: string,
    private readonly document: CreationOutputContent & CreationArtifactWriter,
    private readonly media: CreationOutputContent & CreationArtifactWriter,
  ) {
    this.routes = new FilePackageContent(root, {
      maxBytes: 2048,
      encode: async (r) => Buffer.from(stableJson(route(r))),
      decode: async (b) => route(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b))),
      digest: ({ owner, taskId, digest }) => key({ owner, taskId, digest }),
    });
  }
  async stage(value: unknown, task?: CreationTaskSpec) {
    if (!task) throw new CreationError("invalidInput");
    const media = mediaValue(value),
      channel = media ? "media" : "document",
      digest = await (media ? this.media : this.document).stage(media ? media.value : value, task),
      record: Route = { owner: task.owner, taskId: task.id, digest, channel };
    await this.routes.put(record);
    if (stableJson(await this.routes.read(key(record))) !== stableJson(record)) throw new CreationError("conflict");
    return digest;
  }
  async commit(task: CreationTaskSpec, digest: string) {
    const identity = { owner: task.owner, taskId: task.id, digest: creationDigest(digest) };
    let record: Route;
    try {
      record = await this.routes.read(key(identity));
    } catch (error) {
      // Tasks admitted before typed output routing existed can only have a document output.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.document.commit(task, digest);
      throw error;
    }
    if (record.owner !== task.owner || record.taskId !== task.id || record.digest !== digest)
      throw new CreationError("conflict");
    return (record.channel === "media" ? this.media : this.document).commit(task, digest);
  }
}
