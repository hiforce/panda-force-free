import type { DataView } from "../../shared/data-view.js";
import type { ComposerDraft } from "../contracts/repositories.js";
import type { StateMutations } from "../contracts/mutations.js";
import type { ApplicationState } from "../contracts/state.js";
import type { UploadsPort, SuggestionsPort } from "../contracts/features.js";

/** Callers retain scope, acknowledgement and empty-input guards; recovery never submits input. */
export function restoreComposerInput(
  draft: DataView<Pick<ComposerDraft, "text" | "mentions" | "attachments">>,
  ports: {
    input: Pick<HTMLTextAreaElement, "value">;
    mutations: Pick<StateMutations<Pick<ApplicationState, "composerMentions" | "composerAttachments">>, "set">;
    uploadsPort: Pick<UploadsPort, "renderComposerAttachments">;
    suggestionsPort: Pick<SuggestionsPort, "renderContextTray">;
    viewUpdates: { request(key: "composerLayout"): void };
  },
) {
  ports.input.value = draft.text;
  ports.mutations.set("composerMentions", draft.mentions);
  ports.mutations.set("composerAttachments", draft.attachments);
  ports.uploadsPort.renderComposerAttachments();
  ports.suggestionsPort.renderContextTray();
  ports.viewUpdates.request("composerLayout");
}
