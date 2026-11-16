import type { Translate } from "../../../shared/i18n/messages.js";
import type { DocumentRecord, DocumentSpace } from "../../../shared/documents/contracts.js";
import type { DocumentPlacement } from "../../../shared/documents/placements.js";
import type { DocumentSourceActionResult } from "../../../shared/documents/action-result.js";
import type { EditorialReceipt } from "../../../shared/editorial/contracts.js";
import type { DocumentPublicationActions } from "../action-port.js";
import { setMessageHtml, errorText } from "../../i18n.js";

import { DocumentApiError } from "../api.js";
import { SourceProfileDialog } from "../source-profile.js";
import { publicationConfigurationApi } from "./configuration-api.js";
import type { DocumentPublicationScope } from "./port.js";
import { DocumentModal } from "../modal.js";
import { DocumentDialogs } from "../dialogs.js";
import { DocumentPlacementDialogs } from "./dialogs.js";

import { publicationFrame, publicationLinks } from "./views.js";

export interface PublicationBuildActions {
  open(
    space: DocumentSpace,
    defaults?: { locale: string; returnFocus?: HTMLElement; scope?: DocumentPublicationScope },
  ): void;
  close(): void;
}
export interface PublicationWorkspaceOptions {
  building: PublicationBuildActions;
  channels?: DocumentPublicationActions;
  editorial?: {
    open(document: DocumentRecord, options?: { projectId?: string }): Promise<EditorialReceipt | null>;
    close(): void;
  };
  identityKey?: string;
  destinations?: { open(space: DocumentSpace, scope?: DocumentPublicationScope): void; close(): void };
}
/** This workspace coordinates destination configuration; the editor, builds and publishers own their own state. */
export function createDocumentPublicationWorkspace(t: Translate, options: PublicationWorkspaceOptions) {
  const { building, channels, editorial, identityKey = "", destinations } = options;
  const dialog = document.createElement("dialog"),
    modal = new DocumentModal(t, "documentPlacementDialog");
  let api = publicationConfigurationApi(undefined, identityKey),
    dialogs = new DocumentPlacementDialogs(t, modal, api),
    spacesDialog = new DocumentDialogs(t, modal, api.spaces),
    profileDialog = new SourceProfileDialog(t, modal, api.spaces),
    scope: DocumentPublicationScope | undefined;
  dialog.id = "documentPublicationDialog";
  dialog.setAttribute("aria-labelledby", "documentPublicationTitle");
  dialog.className = "document-publication-dialog";
  document.body.append(dialog);
  let epoch = 0,
    reads = 0,
    busy = false,
    ready = false,
    projectId = "",
    original: DocumentRecord | null = null,
    placements: DocumentPlacement[] = [],
    spaces: DocumentSpace[] = [];
  let previous: Element | null = null,
    settle: ((result: DocumentSourceActionResult | null) => void) | null = null;
  const get = <T extends Element>(selector: string) => dialog.querySelector<T>(selector);
  function notice(text: string, error = false) {
    const node = get<HTMLElement>("#placementNotice");
    if (node) {
      node.textContent = text;
      node.hidden = !text;
      node.dataset.error = String(error);
    }
  }
  function report(error: unknown) {
    notice(errorText(error instanceof DocumentApiError ? error.payload : null, t, "documents.unavailable"), true);
  }
  function controls() {
    const pending = !!api.recovery?.pending;
    const recovery = get<HTMLElement>("#placementRecoveryNotice");
    if (recovery) recovery.hidden = !pending;
    for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-placement-action]")) {
      const action = button.dataset.placementAction;
      button.disabled =
        action !== "close" &&
        (busy ||
          (!ready && !["refresh", "retry"].includes(action!)) ||
          (pending && !["refresh", "history", "retry"].includes(action!)) ||
          (action === "add" && !spaces.length));
    }
  }
  function render() {
    const body = get<HTMLElement>(".document-publication-body"),
      top = body?.scrollTop || 0;
    setMessageHtml(get("#documentPlacementList"), publicationLinks(t, placements, spaces, !!destinations));
    controls();
    if (body) body.scrollTop = top;
  }
  function close(result: DocumentSourceActionResult | null = null) {
    epoch++;
    reads++;
    modal.close();
    building.close();
    destinations?.close();
    channels?.close();
    editorial?.close();
    dialog.close();
    original = null;
    projectId = "";
    placements = [];
    spaces = [];
    ready = false;
    busy = false;
    const finish = settle;
    settle = null;
    finish?.(result);
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    previous = null;
  }
  async function refresh() {
    if (!original) return;
    const generation = epoch,
      read = ++reads,
      id = original.id,
      ports = api;
    const [detail, origin, links] = await Promise.all([
      ports.sources.detail(id),
      ports.spaces.sourceProfile(original.spaceId),
      ports.placements.list(id),
    ]);
    if (generation !== epoch || read !== reads) return;
    const targets = await ports.spaces.spaces(origin.space.projectId);
    if (generation !== epoch || read !== reads) return;
    original = detail.document;
    projectId = origin.space.projectId;
    placements = links.placements;
    spaces = targets.spaces;
    ready = true;
    render();
  }
  async function action(name: string, id: string | undefined, trigger: HTMLButtonElement) {
    const generation = epoch,
      ports = api,
      linkDialogs = dialogs,
      configuration = spacesDialog,
      profiles = profileDialog;
    if (name === "retry") {
      await ports.recovery?.retry();
      if (generation === epoch) await refresh();
      return;
    }
    if (name === "refresh") {
      await refresh();
      return;
    }
    if (!original || !ready) return;
    if (name === "channels" && channels) {
      const result = await channels.open(original, { richtext: true, scope });
      if (generation === epoch && result) close(result);
      return;
    }
    if (name === "spacing" && editorial) {
      const receipt = await editorial.open(
        original,
        scope?.storage === "files" ? { projectId: scope.projectId } : undefined,
      );
      if (generation === epoch && receipt) close({ kind: "source-applied", receipt });
      return;
    }
    const placement = placements.find((value) => value.id === id),
      space = spaces.find((value) => value.id === placement?.spaceId);
    if (name === "build" && placement && space) {
      building.open(space, { locale: placement.locale, returnFocus: trigger, scope });
      return;
    }
    if (name === "delivery" && space && destinations) {
      destinations.open(space, scope);
      return;
    }
    if (name === "history" && placement) {
      await linkDialogs.history(placement);
      return;
    }
    if (name === "remove" && placement) await linkDialogs.remove(placement, space!.version);
    else if (name === "edit" && placement) await linkDialogs.edit(original, spaces, placement);
    else if (name === "add") await linkDialogs.edit(original, spaces);
    else if (name === "theme" && space) await configuration.theme(space);
    else if (name === "source-profile" && space) await profiles.open(space);
    else if (name === "new-space") {
      const created = await configuration.space(projectId, { engine: "hexo", locale: original.locale });
      if (!created || generation !== epoch) return;
      await refresh();
      if (generation !== epoch || !original) return;
      await linkDialogs.edit(original, spaces, undefined, created.id);
    } else return;
    if (generation !== epoch) return;
    await refresh();
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    const trigger =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-placement-action]") : null;
    if (!trigger || trigger.disabled) return;
    const name = trigger.dataset.placementAction!;
    if (name === "close") {
      close();
      return;
    }
    if (busy) return;
    const generation = epoch;
    busy = true;
    controls();
    notice("");
    const id = trigger.dataset.id;
    void action(name, id, trigger)
      .catch((error) => {
        if (generation === epoch) report(error);
      })
      .finally(() => {
        if (generation === epoch) {
          busy = false;
          controls();
          if (name !== "build" && name !== "delivery") {
            const selector =
              `[data-placement-action="${CSS.escape(name)}"]` + (id ? `[data-id="${CSS.escape(id)}"]` : "");
            const target = get<HTMLButtonElement>(selector) || get<HTMLButtonElement>('[data-placement-action="add"]');
            target?.focus({ preventScroll: true });
          }
        }
      });
  });
  return {
    close: () => close(),
    open(
      document: DocumentRecord,
      options?: { scope?: DocumentPublicationScope },
    ): Promise<DocumentSourceActionResult | null> {
      close();
      scope = options?.scope;
      api = publicationConfigurationApi(scope, identityKey);
      dialogs = new DocumentPlacementDialogs(t, modal, api);
      spacesDialog = new DocumentDialogs(t, modal, api.spaces);
      profileDialog = new SourceProfileDialog(t, modal, api.spaces);
      previous = window.document.activeElement;
      original = document;
      setMessageHtml(dialog, publicationFrame(t, document));
      for (const [name, available] of [
        ["channels", !!channels],
        ["spacing", !!editorial],
      ] as const) {
        const button = get<HTMLButtonElement>(`[data-placement-action="${name}"]`);
        if (button) button.hidden = !available;
      }
      const channelSection = get<HTMLElement>(".document-publication-channels");
      if (channelSection) channelSection.hidden = !editorial && !channels;
      dialog.showModal();
      const generation = epoch;
      busy = true;
      notice(t("documents.loadingPublicationLinks"));
      controls();
      void refresh()
        .then(() => {
          if (generation === epoch) notice("");
        })
        .catch((error) => {
          if (generation === epoch) report(error);
        })
        .finally(() => {
          if (generation === epoch) {
            busy = false;
            controls();
          }
        });
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  };
}
