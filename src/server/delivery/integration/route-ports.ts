import type { AwaitableStore } from "../../../shared/async-store.js";
import type { SocialContinuationService } from "../social/continuation.js";
import type { SocialRecoveryService } from "../social/recovery.js";
import type { SocialPublicationService } from "../social/service.js";
export type SocialPublicationRouteService = AwaitableStore<
  Omit<SocialPublicationService, "recovery" | "continuation">
> & {
  recovery?: AwaitableStore<SocialRecoveryService>;
  continuation?: AwaitableStore<SocialContinuationService>;
};
