import type { CreationArtifact } from "../../shared/creation/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { LazyCreativeAssetsPanel } from "../creative/assets-lazy.js";
import type { NotificationIntentHandler } from "../notifications/controller.js";
import { creationDocumentRoute } from "./delivery-route.js";

export function creationNotificationActions(t: Translate, identity: string, navigate: (path: string) => void) {
  const viewer = new LazyCreativeAssetsPanel(t, "notificationDeliveryViewer", identity);
  const intents = {
    "creation.deliverable": {
      label: "notifications.openDeliverable",
      directFromPreview: true,
      async run(value) {
        const artifact = value as CreationArtifact;
        if (!artifact || typeof artifact.projectId !== "string") throw new Error("Invalid creation deliverable");
        if (artifact.kind === "document") navigate(creationDocumentRoute(artifact));
        else await viewer.follow(artifact.projectId, artifact.assetId, async () => {}, artifact.version);
      },
    },
  } satisfies Record<string, NotificationIntentHandler>;
  return { intents, close: () => viewer.close() };
}
