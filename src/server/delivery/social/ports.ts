import type { PublicationImage, UploadedMedia } from "../../../shared/delivery/media.js";
import type { SocialContent, SocialSource, SocialTarget } from "../../../shared/delivery/social.js";
import type { WorkflowRecord, WorkflowRecoveryReport } from "../../../shared/delivery/workflow.js";
import type { XArticleDraft } from "../../../shared/publishing/x-article.js";
export interface SocialCapture {
  projectId: string;
  spaceId: string;
  source: SocialSource;
  content: SocialContent;
  media: PublicationImage[];
}
export interface SocialSources {
  capture(owner: string, variant: string): SocialCapture | Promise<SocialCapture>;
  authorize(
    owner: string,
    source: SocialSource,
    projectId: string,
    spaceId: string,
  ): (() => void) | Promise<() => void>;
  space(owner: string, spaceId: string, projectId?: string): (() => void) | Promise<() => void>;
  readImage(owner: string, source: SocialSource, image: PublicationImage): Promise<Uint8Array>;
  article(
    owner: string,
    source: SocialSource,
    preview: XArticleDraft,
    images: { image: PublicationImage; uploaded: UploadedMedia }[],
  ): XArticleDraft | Promise<XArticleDraft>;
}
export interface SocialAccess {
  accessToken: string;
  accountId: string;
  guard(): void | Promise<void>;
}
export interface SocialAccounts {
  target(owner: string, id: string): SocialTarget;
  assert(owner: string, target: SocialTarget, purpose?: "media"): void;
  access(owner: string, target: SocialTarget, purpose?: "media"): Promise<SocialAccess>;
}

export interface SocialRecoveryReader {
  validate(record: WorkflowRecord, stepId: number): void;
  inspect(
    access: SocialAccess,
    record: WorkflowRecord,
    stepId: number,
    remoteId: string,
  ): Promise<WorkflowRecoveryReport>;
}
