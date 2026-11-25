import type { ApplicationRuntimePort } from "../../engines/application-tools/runtime-port.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CreationEngineProfile } from "../../../shared/creation/contracts.js";
import { creationEngineProfile } from "./input-codec.js";
import { CreationError } from "../contracts.js";
import { creationId, creationRecord, creationText } from "../validation.js";
import { isRecord } from "../../../shared/records.js";
import { defaultCreationEffort } from "../../../shared/creation/effort.js";

export interface CreationProfileSettings {
  profiles: readonly CreationEngineProfile[];
  defaultProfileId: string | null;
  enabled: boolean;
  invalid: boolean;
}
/** Administrator files choose named engine profiles; document input cannot choose endpoints, processes or secret files. */
export function creationProfileSettings(
  stateRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): CreationProfileSettings {
  try {
    if (env.PANDA_FORCE_CREATION_ENABLED !== undefined && !["true", "false"].includes(env.PANDA_FORCE_CREATION_ENABLED))
      throw new CreationError("invalidInput");
    if (env.PANDA_FORCE_CREATION_ENABLED === "false")
      return { enabled: false, invalid: false, profiles: [], defaultProfileId: null };
    const path = env.PANDA_FORCE_CREATION_CONFIG_FILE || join(stateRoot, "config", "creation-engines.json");
    if (!existsSync(path)) {
      if (env.PANDA_FORCE_CREATION_CONFIG_FILE) throw new CreationError("invalidInput");
      return {
        enabled: true,
        invalid: false,
        profiles: [{ id: "codex", engineId: "codex" }],
        defaultProfileId: "codex",
      };
    }
    const info = statSync(path);
    if (!info.isFile() || info.size > 32768) throw new CreationError("invalidInput");
    const bytes = readFileSync(path);
    if (bytes.length > 32768) throw new CreationError("invalidInput");
    const input = creationRecord(JSON.parse(bytes.toString("utf8")), ["schema", "profiles", "defaultProfileId"]);
    if (input.schema !== 1 || !Array.isArray(input.profiles) || input.profiles.length > 16)
      throw new CreationError("invalidInput");
    const profiles = input.profiles.map(creationEngineProfile),
      defaultProfileId = input.defaultProfileId === null ? null : creationId(input.defaultProfileId);
    if (
      new Set(profiles.map((profile) => profile.id)).size !== profiles.length ||
      (profiles.length && !profiles.some((profile) => profile.id === defaultProfileId))
    )
      throw new CreationError("invalidInput");
    return { enabled: !!profiles.length, invalid: false, profiles, defaultProfileId };
  } catch {
    return { enabled: false, invalid: true, profiles: [], defaultProfileId: null };
  }
}
export class CreationProfiles {
  constructor(
    readonly settings: CreationProfileSettings,
    private readonly engines: ReadonlySet<string>,
    private readonly defaultModel: (engineId: string, catalog?: unknown) => Promise<string>,
    private readonly models?: () => Promise<unknown>,
    private readonly runtimes?: ApplicationRuntimePort,
  ) {}
  async resolve(id: string, selection?: { runtimeId?: string; model?: string; effort?: string }, owner?: string) {
    const configured = this.settings.profiles.find((profile) => profile.id === id);
    if (!this.settings.enabled || !configured || !this.engines.has(configured.engineId))
      throw new CreationError("unavailable");
    if (this.runtimes && selection?.runtimeId && owner) {
      const selected = await this.runtimes.resolve(owner, selection, "creation").catch(() => {
        throw new CreationError("runtimeSelectionUnavailable");
      });
      return {
        ...configured,
        runtimeId: selected.runtimeId,
        model: selected.model,
        effort: selected.effort || undefined,
        engineId: selected.runtimeId === "codex" ? "codex" : `harness-${selected.runtimeId}`,
      };
    }
    const validate = Boolean(selection?.model || selection?.effort),
      catalog = this.models && (validate || !configured.effort) ? await this.models() : undefined;
    const result = {
      ...configured,
      model: configured.model ?? creationText(await this.defaultModel(configured.engineId, catalog), 128),
    };
    if (validate || catalog !== undefined) {
      if (!isRecord(catalog) || !Array.isArray(catalog.data)) throw new CreationError("unavailable");
      const model = catalog.data.find(
        (entry) => isRecord(entry) && (entry.model ?? entry.id) === (selection?.model || result.model),
      );
      if (!isRecord(model) || model.hidden === true) throw new CreationError("invalidInput");
      const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
      const supported = efforts.flatMap((item) =>
          isRecord(item) && typeof item.reasoningEffort === "string" ? [item.reasoningEffort] : [],
        ),
        effort =
          selection?.effort ??
          (!selection?.model || selection.model === result.model ? configured.effort : undefined) ??
          (supported.length
            ? defaultCreationEffort(
                supported,
                typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : "",
              )
            : "");
      if (effort && !efforts.some((item) => isRecord(item) && item.reasoningEffort === effort))
        throw new CreationError("invalidInput");
      result.model = creationText(model.model ?? model.id, 128);
      if (effort) result.effort = creationId(effort);
    }
    return result;
  }
  async list() {
    if (!this.settings.enabled)
      return {
        state: this.settings.invalid ? ("unavailable" as const) : ("unconfigured" as const),
        profiles: [],
        defaultProfileId: null,
      };
    if (this.runtimes && this.settings.profiles.every((profile) => this.engines.has(profile.engineId)))
      return {
        state: "ready" as const,
        profiles: this.settings.profiles.map((profile) => ({ ...profile })),
        defaultProfileId: this.settings.defaultProfileId,
      };
    try {
      const profiles = await Promise.all(this.settings.profiles.map((profile) => this.resolve(profile.id)));
      return { state: "ready" as const, profiles, defaultProfileId: this.settings.defaultProfileId };
    } catch {
      return { state: "unavailable" as const, profiles: [], defaultProfileId: null };
    }
  }
}
