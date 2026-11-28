import { originalStorageKinds, type OriginalStorageKind } from "../../shared/storage/contracts.js";
import { creativeKindMessages } from "../../shared/creative/file-types.js";
import { storageToolsPath, type RegisteredStorageConnection } from "../../shared/workspace-tools/storage.js";
import { storageProviderLabel } from "../workspace-tools/storage-editor.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";

export interface OriginalStorageForm {
  kinds: OriginalStorageKind[];
  profileId: string;
}
export const emptyOriginalStorageForm = (): OriginalStorageForm => ({
  kinds: ["image", "video"],
  profileId: "",
});
export function readOriginalStorageForm(root: HTMLElement, previous: OriginalStorageForm): OriginalStorageForm {
  const destination = root.querySelector<HTMLSelectElement>('[data-storage-field="profileId"]');
  if (!destination) return previous;
  return {
    profileId: destination.value,
    kinds: [...root.querySelectorAll<HTMLInputElement>("[data-storage-kind]:checked")].map(
      (control) => control.dataset.storageKind as OriginalStorageKind,
    ),
  };
}
export function originalStorageHtml(
  t: Translate,
  connections: RegisteredStorageConnection[] | null,
  form: OriginalStorageForm,
  pending: boolean,
  retry: boolean,
) {
  const targets = connections?.filter((row) => row.provider !== "google-drive") ?? [];
  const knownChoice = targets.some((row) => row.id === form.profileId);
  return `<section class="original-storage-settings"><header class="original-storage-heading"><div><h2 tabindex="-1" data-storage-title>${e(t("storage.placementTitle"))}</h2><p>${e(t("storage.originalsIntro"))}</p></div><button type="button" class="wb-button" data-storage-action="reload">${e(t("storage.reload"))}</button></header>
    <p class="original-storage-notice" data-storage-notice role="status" aria-live="polite"></p>
    <div class="original-storage-recovery" ${pending ? "" : "hidden"}><p>${e(t("storage.unknownSave"))}</p><div class="original-storage-actions"><button type="button" class="wb-button" data-storage-action="check">${e(t("storage.checkSave"))}</button>${retry ? `<button type="button" class="wb-button" data-storage-action="retry">${e(t("storage.retrySave"))}</button>` : ""}<button type="button" class="wb-button" data-storage-action="current">${e(t("storage.useCurrent"))}</button></div></div>
    <div data-storage-configuration ${connections ? "" : "hidden"}><form class="wb-form original-storage-placement" data-storage-form="placement"><fieldset data-storage-fields>
      <div class="original-storage-target">
        <label class="wb-field"><span>${e(t("storage.destination"))}</span><select data-storage-field="profileId" name="pf-original-profileId">
          <option value="" ${!form.profileId ? "selected" : ""}>${e(t("storage.local"))}</option>
          ${form.profileId && !knownChoice ? `<option value="${e(form.profileId)}" selected>${e(t("storage.missingDestination"))}</option>` : ""}
          ${targets.map((row) => `<option value="${e(row.id)}" ${row.id === form.profileId ? "selected" : ""} data-i18n-ignore>${e(row.name)} · ${e(t(storageProviderLabel[row.provider]))}</option>`).join("")}
        </select></label>
        <a class="wb-button" href="${storageToolsPath}">${e(t("storage.manageConnections"))}</a>
      </div>
      ${targets.length ? "" : `<p class="original-storage-hint">${e(t("storage.addDestinationHint"))}</p>`}
      <div class="original-storage-s3" data-storage-s3 ${form.profileId ? "" : "hidden"}><fieldset>
        <legend>${e(t("storage.destinationKinds"))}</legend>
        <div class="original-storage-kinds">${originalStorageKinds.map((kind) => `<label class="wb-choice"><input type="checkbox" data-storage-kind="${kind}" name="pf-original-kind-${kind}" ${form.kinds.includes(kind) ? "checked" : ""}><span>${e(t(kind === "project-memory-package" ? "storage.projectMemoryPackages" : creativeKindMessages[kind]))}</span></label>`).join("")}</div>
        <p class="original-storage-hint">${e(t("storage.otherKindsLocal"))}</p>
      </fieldset></div>
      <div class="original-storage-actions">
        <button type="submit" class="wb-button primary" data-storage-save>${e(t("storage.savePlacement"))}</button>
        <p class="original-storage-inline-notice" data-storage-inline-notice aria-hidden="true"></p>
      </div>
    </fieldset></form></div>
    ${connections?.some((row) => row.provider === "google-drive") ? `<p class="original-storage-hint">${e(t("storage.drivePlacementHint"))}</p>` : ""}
  </section>`;
}
