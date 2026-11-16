import { templateInteger, templateObject, templateText } from "../../../shared/templates/portable/validation.js";
import { PortableRegistryError } from "../portable/errors.js";
import { portableActor } from "../portable/commands.js";
import { stableJson } from "../../../shared/stable-json.js";
import { contentSha256 } from "../../../shared/packages/digest.js";
import type { TemplateDraftMutation } from "./ports.js";

/** Capture only bounded JSON data; accessors and custom prototypes cannot contribute hidden command behavior. */
function captureIntent(value: unknown): Record<string, unknown> {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 200000 || item.depth > 80) throw new PortableRegistryError("invalidInput");
    const current = item.value;
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number" && Number.isFinite(current)) continue;
    if (
      !current ||
      typeof current !== "object" ||
      (!Array.isArray(current) && ![Object.prototype, null].includes(Object.getPrototypeOf(current)))
    )
      throw new PortableRegistryError("invalidInput");
    for (const key of Reflect.ownKeys(current)) {
      if (Array.isArray(current) && key === "length") continue;
      if (typeof key !== "string") throw new PortableRegistryError("invalidInput");
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      if (descriptor.get || descriptor.set) throw new PortableRegistryError("invalidInput");
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > 3 * 1024 * 1024) throw new PortableRegistryError("invalidInput");
  return JSON.parse(json);
}

export function templateDraftId(value: unknown) {
  const id = templateText(value, 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new PortableRegistryError("invalidInput");
  return id;
}
export async function templateDraftCommand(actor: string, kind: "create" | "fork" | "save" | "remove", value: unknown) {
  portableActor(actor);
  const keys =
    kind === "create"
      ? ["templateType", "definition"]
      : kind === "fork"
        ? ["reference"]
        : kind === "save"
          ? ["definition"]
          : [];
  const input = templateObject(value, ["operationId", "id", "expectedRevision", ...keys]);
  // Detached JSON is the exact intent of the command, independently of later draft or registry changes.
  const captured = captureIntent(input);
  const command: TemplateDraftMutation = {
    actor,
    id: templateDraftId(captured.id),
    operationId: templateDraftId(captured.operationId),
    expectedRevision: templateInteger(captured.expectedRevision, 0, Number.MAX_SAFE_INTEGER),
    request: await contentSha256(stableJson({ kind, ...captured })),
    now: Date.now(),
  };
  if ((kind === "create" || kind === "fork") && command.expectedRevision !== 0)
    throw new PortableRegistryError("invalidInput");
  return { command, input: captured };
}
