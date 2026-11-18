import type { OriginalStorageSettings, OriginalStorageProfile } from "../../shared/storage/contracts.js";
import { CREATIVE_ASSET_KINDS, type CreativeAssetKind } from "../../shared/creative/assets.js";
import { creativeKindMessages } from "../../shared/creative/file-types.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
export interface OriginalStorageForm {
  mode: "local" | "s3";
  kinds: CreativeAssetKind[];
  profileId: string;
  label: string;
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  repairProfile: string;
  repairAccessKeyId: string;
  repairSecretAccessKey: string;
  repairSessionToken: string;
}
export const emptyOriginalStorageForm = (): OriginalStorageForm => ({
  mode: "local",
  kinds: ["image", "video"],
  profileId: "",
  label: "",
  bucket: "",
  region: "us-east-1",
  prefix: "",
  endpoint: "",
  forcePathStyle: true,
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  repairProfile: "",
  repairAccessKeyId: "",
  repairSecretAccessKey: "",
  repairSessionToken: "",
});
export function applyOriginalStorageProfile(form: OriginalStorageForm, profile?: OriginalStorageProfile) {
  Object.assign(form, {
    profileId: profile?.id ?? "",
    label: profile?.label ?? "",
    bucket: profile?.bucket ?? "",
    region: profile?.region ?? "us-east-1",
    prefix: profile?.prefix ?? "",
    endpoint: profile?.endpoint ?? "",
    forcePathStyle: profile?.forcePathStyle ?? true,
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
  });
}
export function readOriginalStorageForm(root: HTMLElement, previous: OriginalStorageForm): OriginalStorageForm {
  const form = { ...previous };
  for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-storage-field]")) {
    const key = control.dataset.storageField as keyof OriginalStorageForm;
    if (key === "mode") form.mode = control.value === "s3" ? "s3" : "local";
    else if (key === "forcePathStyle" && control instanceof HTMLInputElement) form.forcePathStyle = control.checked;
    else if (key !== "kinds" && key !== "forcePathStyle") form[key] = control.value;
  }
  const kinds = [...root.querySelectorAll<HTMLInputElement>("[data-storage-kind]:checked")].map(
    (control) => control.dataset.storageKind as CreativeAssetKind,
  );
  if (root.querySelector("[data-storage-kind]")) form.kinds = kinds;
  return form;
}
export function clearOriginalStorageSecrets(form: OriginalStorageForm) {
  for (const key of [
    "accessKeyId",
    "secretAccessKey",
    "sessionToken",
    "repairAccessKeyId",
    "repairSecretAccessKey",
    "repairSessionToken",
  ] as const)
    form[key] = "";
}
export function originalStorageHtml(
  t: Translate,
  settings: OriginalStorageSettings | null,
  form: OriginalStorageForm,
  pending: boolean,
  retry: boolean,
) {
  const field = (key: MessageId, name: keyof OriginalStorageForm, password = false) =>
      `<label class="wb-field"><span>${e(t(key))}</span><input type="${password ? "password" : "text"}" data-storage-field="${name}" name="pf-original-${name}" value="${e(String(form[name]))}" autocomplete="${password ? "new-password" : "off"}" spellcheck="false" maxlength="${name.toLowerCase().includes("token") ? 16384 : 2048}"></label>`,
    select = (name: "profileId" | "repairProfile", label: MessageId, allowNew: boolean) =>
      `<label class="wb-field"><span>${e(t(label))}</span><select data-storage-field="${name}" name="pf-original-${name}">${allowNew ? `<option value="">${e(t("storage.newConnection"))}</option>` : ""}${settings?.profiles.map((p) => `<option value="${e(p.id)}" ${form[name] === p.id ? "selected" : ""} data-i18n-ignore>${e(p.label)} · ${e(p.bucket)}</option>`).join("") ?? ""}</select></label>`,
    profile = settings?.profiles.find((p) => p.id === form.profileId);
  return `<section class="original-storage-settings"><header class="original-storage-heading"><div><h2 tabindex="-1" data-storage-title>${e(t("storage.originalsTitle"))}</h2><p>${e(t("storage.originalsIntro"))}</p></div><button type="button" class="wb-button" data-storage-action="reload">${e(t("storage.reload"))}</button></header>
    <p class="original-storage-notice" data-storage-notice role="status" aria-live="polite"></p>
    <div class="original-storage-recovery" ${pending ? "" : "hidden"}><p>${e(t("storage.unknownSave"))}</p><div class="original-storage-actions"><button type="button" class="wb-button" data-storage-action="check">${e(t("storage.checkSave"))}</button>${retry ? `<button type="button" class="wb-button" data-storage-action="retry">${e(t("storage.retrySave"))}</button>` : ""}<button type="button" class="wb-button" data-storage-action="current">${e(t("storage.useCurrent"))}</button></div></div>
    <div data-storage-configuration ${settings ? "" : "hidden"}><form class="wb-form" data-storage-form="configure"><fieldset data-storage-fields><label class="wb-field"><span>${e(t("storage.mode"))}</span><select data-storage-field="mode" name="pf-original-mode"><option value="local" ${form.mode === "local" ? "selected" : ""}>${e(t("storage.local"))}</option><option value="s3" ${form.mode === "s3" ? "selected" : ""}>${e(t("storage.s3"))}</option></select></label>
      <div class="original-storage-s3" data-storage-s3 ${form.mode === "s3" ? "" : "hidden"}><fieldset><legend>${e(t("storage.kinds"))}</legend><div class="original-storage-kinds">${CREATIVE_ASSET_KINDS.map((kind) => `<label class="wb-choice"><input type="checkbox" data-storage-kind="${kind}" name="pf-original-kind-${kind}" ${form.kinds.includes(kind) ? "checked" : ""}><span>${e(t(creativeKindMessages[kind]))}</span></label>`).join("")}</div></fieldset>
      ${select("profileId", "storage.connection", true)}<div class="wb-form-grid">${field("storage.label", "label")}${field("storage.bucket", "bucket")}${field("storage.region", "region")}${field("storage.prefix", "prefix")}</div>
      <details data-storage-detail="connection"><summary>${e(t("storage.advanced"))}</summary><div class="wb-form">${field("storage.endpoint", "endpoint")}<p class="original-storage-hint">${e(t("storage.endpointHint"))}</p><label class="wb-choice"><input type="checkbox" data-storage-field="forcePathStyle" name="pf-original-forcePathStyle" ${form.forcePathStyle ? "checked" : ""}><span>${e(t("storage.pathStyle"))}</span></label></div></details>
      <details data-storage-detail="credentials" ${profile ? "" : "open"}><summary>${e(t("storage.credentials"))}</summary><div class="wb-form">${profile ? `<p>${e(t("storage.keyHint", { hint: profile.accessKeyHint }))}</p>` : ""}<div class="wb-form-grid">${field("storage.accessKeyId", "accessKeyId", true)}${field("storage.secretAccessKey", "secretAccessKey", true)}${field("storage.sessionToken", "sessionToken", true)}</div><p class="original-storage-hint">${e(t("storage.credentialHint"))}</p></div></details></div>
      <p class="original-storage-notice" data-storage-inline-notice="configure" aria-hidden="true"></p><button type="submit" class="wb-button primary" data-storage-save>${e(t("storage.save"))}</button></fieldset></form>
      ${settings?.profiles.length ? `<details data-storage-detail="repair" class="original-storage-repair"><summary>${e(t("storage.repairTitle"))}</summary><p class="original-storage-hint">${e(t("storage.repairHint"))}</p><form class="wb-form" data-storage-form="credentials"><fieldset data-storage-fields>${select("repairProfile", "storage.connection", false)}<div class="wb-form-grid">${field("storage.accessKeyId", "repairAccessKeyId", true)}${field("storage.secretAccessKey", "repairSecretAccessKey", true)}${field("storage.sessionToken", "repairSessionToken", true)}</div><p class="original-storage-notice" data-storage-inline-notice="credentials" aria-hidden="true"></p><button type="submit" class="wb-button" data-storage-save>${e(t("storage.repairSave"))}</button></fieldset></form></details>` : ""}
    </div><aside class="original-storage-policy"><p>${e(t("storage.privacyHint"))}</p><p>${e(t("storage.trashHint"))}</p><p class="original-storage-hint">${e(t("storage.independentHint"))}</p></aside></section>`;
}
