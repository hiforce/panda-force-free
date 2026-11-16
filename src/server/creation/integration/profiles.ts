import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CreationEngineProfile } from "../../../shared/creation/contracts.js";
import { creationEngineProfile } from "./input-codec.js";
import { CreationError } from "../contracts.js";
import { creationId, creationRecord, creationText } from "../validation.js";

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
    private readonly defaultModel: (engineId: string) => Promise<string>,
  ) {}
  async resolve(id: string) {
    const configured = this.settings.profiles.find((profile) => profile.id === id);
    if (!this.settings.enabled || !configured || !this.engines.has(configured.engineId))
      throw new CreationError("unavailable");
    return {
      ...configured,
      model: configured.model ?? creationText(await this.defaultModel(configured.engineId), 128),
    };
  }
  async list() {
    if (!this.settings.enabled)
      return {
        state: this.settings.invalid ? ("unavailable" as const) : ("unconfigured" as const),
        profiles: [],
        defaultProfileId: null,
      };
    try {
      const profiles = await Promise.all(this.settings.profiles.map((profile) => this.resolve(profile.id)));
      return { state: "ready" as const, profiles, defaultProfileId: this.settings.defaultProfileId };
    } catch {
      return { state: "unavailable" as const, profiles: [], defaultProfileId: null };
    }
  }
}
