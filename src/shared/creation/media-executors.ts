export type CreationMediaKind = "image" | "video";
export const executorKinds = ["image", "audio", "video", "text"] as const;
export type ExecutorKind = (typeof executorKinds)[number];
export type ExecutorCategory = ExecutorKind | "cli";
export type ExecutorProvider =
  | "openai"
  | "xai"
  | "zhipu"
  | "volcengine"
  | "google"
  | "stability"
  | "black-forest-labs"
  | "recraft"
  | "ideogram"
  | "alibaba-cloud"
  | "fal";

export function isExecutorKind(value: unknown): value is ExecutorKind {
  return executorKinds.some((kind) => kind === value);
}

export type CreationMediaChoice =
  | { kind: CreationMediaKind; source: "harness" }
  | { kind: CreationMediaKind; source: "executor"; executorId: string; model?: string };

export type CreationMediaBinding =
  | Extract<CreationMediaChoice, { source: "harness" }>
  | {
      kind: CreationMediaKind;
      source: "executor";
      executorId: string;
      model: string;
      preset: string;
      presetVersion: number;
      revision: number;
      credentialRevision?: number;
    };

export interface CreationMediaModel {
  id: string;
  name: string;
}

export interface CreationMediaPreset {
  id: string;
  version: number;
  name: string;
  kind: ExecutorKind;
  provider?: ExecutorProvider;
  transport?: "cli";
  fixedEndpoint?: true;
  models: readonly CreationMediaModel[];
}

export function executorCredentialTarget(preset: Pick<CreationMediaPreset, "provider" | "id">) {
  return preset.provider ?? preset.id;
}

export interface CreationMediaCredential {
  id: string;
  name: string;
  target: string;
  revision: number;
  baseUrl?: string;
}

export interface CreationMediaExecutor {
  id: string;
  name: string;
  preset: string;
  presetVersion: number;
  kind: ExecutorKind;
  model?: string;
  credentialId?: string;
  credentialUnavailable?: true;
  revision: number;
  status: "connected" | "unverified";
}

export interface CreationMediaCliRegistration {
  id: string;
  name: string;
  kind: CreationMediaKind;
  version: string;
  revision: number;
  sha256: string;
  fingerprint: string;
  registered: boolean;
}

export interface CreationMediaCliInstructions {
  install: string;
  usage: string;
}

export interface HarnessCreationCapabilities {
  catalogVersion: number;
  reviewedOn: string;
  text: boolean;
  applicationTools: boolean;
  imageUnderstanding: boolean;
  imageEditing: boolean;
  nativeImage: boolean;
  nativeImageStatus: "available" | "unsupported" | "unverified";
  nativeVideo: boolean;
}
