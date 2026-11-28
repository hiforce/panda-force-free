import type {
  CreationMediaCredential,
  CreationMediaExecutor,
  CreationMediaPreset,
  ExecutorCategory,
  ExecutorProvider,
} from "../../shared/creation/media-executors.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";

export const credentialEndpoint = "/api/personal/creation-media-credentials";
export const executorEndpoint = "/api/personal/creation-media-executors";

export interface ExecutorCatalog {
  configured?: boolean;
  presets: CreationMediaPreset[];
  executors: CreationMediaExecutor[];
  credentials?: CreationMediaCredential[];
}

export const categoryLabels = {
  image: "creation.executorImage",
  audio: "creation.executorAudio",
  video: "creation.executorVideo",
  text: "creation.executorText",
  cli: "creation.executorCli",
} as const satisfies Record<ExecutorCategory, MessageId>;

export const categoryIcons = {
  image: "image",
  audio: "mic",
  video: "play",
  text: "file",
  cli: "terminal",
} as const satisfies Record<ExecutorCategory, string>;

const providerLabels = {
  openai: "creation.executorOpenAi",
  xai: "creation.executorXAi",
  zhipu: "creation.executorZhipu",
  volcengine: "creation.executorVolcengine",
  google: "creation.executorGoogle",
  stability: "creation.executorStability",
  "black-forest-labs": "creation.executorBlackForestLabs",
  recraft: "creation.executorRecraft",
  ideogram: "creation.executorIdeogram",
  "alibaba-cloud": "creation.executorAlibabaCloud",
  fal: "creation.executorFal",
} as const satisfies Record<ExecutorProvider, MessageId>;

export function executorCategory(kind: CreationMediaExecutor["kind"], preset?: CreationMediaPreset) {
  return preset?.transport === "cli" ? "cli" : kind;
}

export function providerName(t: Translate, preset: CreationMediaPreset) {
  return preset.provider ? t(providerLabels[preset.provider]) : preset.name;
}
