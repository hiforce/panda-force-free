import type { MemoryMaterialHit } from "../../shared/project-memory/materials.js";
import type { MemoryEntry } from "../../shared/project-memory/contracts.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import {
  memoryPackageExtension,
  memoryPackageUploadMaxBytes,
  type MemoryPackageUpload,
  type MemoryPackageTransfer,
  type MemoryArchiveImport,
  type MemoryArchivePreview,
} from "../../shared/project-memory/archive.js";
import { pmfMinimumBytes } from "../../shared/project-memory/pmf-envelope.js";
import { decodeBase64Url, keySettingsPath, listEncryptionKeys, type KeyBackup } from "../encryption-keys/key-store.js";
import { escapeHtml as escape } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { request } from "../http-client.js";
import { confirmAction } from "../confirmation-dialog.js";
import { harnessApi } from "../harness/api.js";
import { messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";
import {
  downloadMemoryPackage,
  readMemoryPackageRecipient,
  readMemoryPackageEnvelope,
  unwrapMemoryPackageKey,
  uploadMemoryPackage,
} from "./memory-package-transfer.js";

import {
  bindMemoryMaterialList,
  bindMemoryNativeCopies,
  memoryMaterialPicker,
  memoryMaterialList,
} from "./memory-package-materials.js";
import { memoryCitationEditor } from "./memory-package-citation-editor.js";
import { memoryPackageReader } from "./memory-package-reader.js";
import { memoryPackageQueue } from "./memory-package-queue.js";

const actions = {
  added: "projects.memoryPackageAdded",
  duplicate: "projects.memoryPackageDuplicate",
  conflict: "projects.memoryPackageConflict",
} as const;

export function memoryPackageSources(
  t: Translate,
  packages: readonly string[] = [],
  entry?: Pick<MemoryEntry, "key" | "scope">,
) {
  return packages
    .map((id) => {
      const label = `${messageHtml("projects.memoryPackageSource", {}, t)} <code data-i18n-ignore>${escape(id.slice(0, 8))}</code>`;
      return entry
        ? `<li><button type="button" class="memory-material-link" data-package-source="${escape(id)}" data-memory-key="${escape(entry.key)}" data-memory-scope="${escape(entry.scope)}" aria-haspopup="dialog">${label}</button></li>`
        : `<li>${label}</li>`;
    })
    .join("");
}

export function createMemoryPackages(t: Translate) {
  const api = harnessApi(t);
  const m = (id: MessageId) => messageHtml(id, {}, t);
  let active: { dialog: HTMLDialogElement; controller: AbortController } | undefined;

  function close() {
    active?.controller.abort();
    active?.dialog.close();
  }

  function open(title: MessageId, trigger: HTMLElement, body: string) {
    close();
    const controller = new AbortController();
    const dialog = document.createElement("dialog");
    dialog.className = "workbench-dialog document-dialog memory-package-dialog";
    dialog.setAttribute("aria-labelledby", "memoryPackageTitle");
    active = { dialog, controller };
    setMessageHtml(
      dialog,
      `<header>
        <h2 id="memoryPackageTitle" tabindex="-1">${m(title)}</h2>
        <button type="button" class="wb-button memory-package-close" data-memory-package-close
          ${messageAttributes("aria-label", "common.close", {}, t)} ${messageAttributes("data-tooltip", "common.close", {}, t)}>${codexIcon("x")}</button>
      </header>${body}`,
    );
    dialog.querySelector<HTMLButtonElement>("[data-memory-package-close]")!.onclick = close;
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener(
      "close",
      () => {
        controller.abort();
        dialog.remove();
        if (active?.dialog === dialog) {
          active = undefined;
          if (trigger.isConnected) trigger.focus({ preventScroll: true });
        }
      },
      { once: true },
    );
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLElement>("h2")!.focus({ preventScroll: true });
    return { dialog, controller };
  }

  function showImport(project: string, trigger: HTMLElement, changed: () => void) {
    const path = "/api/projects/" + encodeURIComponent(project) + "/";
    const uploadPath = path + "memory-upload";
    let selected: File | undefined;
    let addressing: Awaited<ReturnType<typeof readMemoryPackageRecipient>> | undefined;
    let uploadId: string | undefined;
    let remoteMode = false;
    let remoteTask: MemoryPackageTransfer | undefined;
    let unlocked: string | undefined;
    let transfer: AbortController | undefined;
    let preview: MemoryArchivePreview | undefined;
    let busy = false;
    let receiptsRequest = 0;
    let savedImports: MemoryArchiveImport[] = [];

    const { dialog, controller } = open(
      "projects.memoryPackageImportTitle",
      trigger,
      `<section class="memory-package-body">
      <section class="memory-package-queue" data-memory-queue hidden>
        <h3>${m("projects.memoryPackageQueue")}</h3>
        <ul data-memory-queue-list></ul>
        <p role="status"></p>
      </section>
      <form class="wb-form">
        <input type="file" accept="${memoryPackageExtension}" hidden data-memory-package-file>
        <button type="button" class="memory-package-drop" data-memory-package-choose
          ${messageAttributes("aria-label", "projects.memoryPackageChoose", {}, t)} aria-describedby="memoryPackageHint">
          <span class="memory-package-file-icon">${codexIcon("arrowUp")}</span>
          <span class="memory-package-file-copy">
            <strong data-memory-package-name>${m("projects.memoryPackageChoose")}</strong>
            <small id="memoryPackageHint">${m("projects.memoryPackageDropHint")}</small>
          </span>
        </button>
        <div class="memory-package-transfer" data-memory-package-transfer hidden>
          <div><label for="memoryPackageProgress">${m("projects.memoryPackageUploading")}</label>
            <span data-memory-package-percent></span></div>
          <progress id="memoryPackageProgress" max="100" value="0"></progress>
        </div>
        <label class="wb-field" data-memory-package-unlock hidden><span>${m("settings.encryptionKeyPassphrase")}</span>
          <input type="password" autocomplete="off" maxlength="1024"></label>
        <a href="${keySettingsPath}" class="wb-button memory-package-settings-link" data-memory-package-settings hidden>${m("settings.encryptionKeys")}</a>
        <p role="status" data-memory-package-status></p>
        <div data-memory-package-preview></div>
        <div class="memory-package-actions" hidden>
          <button type="button" class="wb-button" data-memory-package-stop hidden>${m("projects.memoryPackagePause")}</button>
          <button type="button" class="wb-button primary" data-memory-package-review hidden disabled>${m("projects.memoryPackagePreview")}</button>
          <button type="submit" class="wb-button primary" hidden disabled>${m("projects.memoryPackageImport")}</button>
        </div>
      </form>
      <details><summary>${m("projects.memoryPackageImports")}</summary><div data-memory-package-history></div></details>
      </section>`,
    );
    const get = <T extends Element>(selector: string) => dialog.querySelector<T>(selector)!;
    const form = get<HTMLFormElement>("form");
    const file = get<HTMLInputElement>("[data-memory-package-file]");
    const picker = get<HTMLButtonElement>("[data-memory-package-choose]");
    const fileName = get<HTMLElement>("[data-memory-package-name]");
    const fileHint = get<HTMLElement>("#memoryPackageHint");
    const transferRow = get<HTMLElement>("[data-memory-package-transfer]");
    const progress = get<HTMLProgressElement>("progress");
    const percentText = get<HTMLElement>("[data-memory-package-percent]");
    const stop = get<HTMLButtonElement>("[data-memory-package-stop]");
    const unlock = get<HTMLLabelElement>("[data-memory-package-unlock]");
    const password = get<HTMLInputElement>("[type=password]");
    const keyLink = get<HTMLAnchorElement>("[data-memory-package-settings]");
    const actionRow = get<HTMLElement>(".memory-package-actions");
    const review = get<HTMLButtonElement>("[data-memory-package-review]");
    const submit = get<HTMLButtonElement>('[type="submit"]');
    const status = get<HTMLElement>("[data-memory-package-status]");
    const queueSection = get<HTMLElement>("[data-memory-queue]");
    const shell = get<HTMLElement>("[data-memory-package-preview]");
    const receipts = get<HTMLDetailsElement>("details");
    const history = get<HTMLElement>("[data-memory-package-history]");
    bindMemoryMaterialList(
      history,
      (id) => savedImports.find((item) => item.packageId === id && !item.withdrawn)?.materials,
      memoryPackageReader(dialog, path, t, controller.signal),
      controller.signal,
    );

    function uploadsRemotely() {
      return remoteTask ? remoteTask.state === "uploading" : remoteMode && !uploadId;
    }
    function controls() {
      file.disabled = picker.disabled = busy;
      queueSection.toggleAttribute("data-reviewing", !!preview && !!remoteTask);
      const cloud = uploadsRemotely();
      unlock.hidden = cloud || !addressing?.recipient || !!preview || !!transfer;
      password.disabled = busy || unlock.hidden;
      keyLink.hidden = cloud || addressing === undefined || !!addressing.recipient;
      review.hidden = cloud ? !selected || !!transfer : unlock.hidden;
      review.disabled = busy || review.hidden || (!cloud && !password.value);
      review.textContent = t(cloud ? "projects.memoryPackageUploadAction" : "projects.memoryPackagePreview");
      stop.hidden = !transfer;
      submit.hidden =
        !preview ||
        preview.imported ||
        preview.withdrawn ||
        !(preview.added + preview.conflict + (preview.materials?.length ?? 0));
      submit.disabled = busy || submit.hidden;
      actionRow.hidden = review.hidden && stop.hidden && submit.hidden;
    }
    function summary(result: Pick<MemoryArchivePreview, "added" | "duplicate" | "conflict" | "invalid">) {
      const { added, duplicate, conflict, invalid } = result;
      return t("projects.memoryPackageSummary", { added, duplicate, conflict, invalid });
    }
    async function run(work: () => Promise<void>) {
      if (busy || controller.signal.aborted) return;
      busy = true;
      controls();
      status.textContent = t("common.pageLoading");
      try {
        await work();
      } catch (error) {
        if (!controller.signal.aborted)
          status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
      } finally {
        busy = false;
        if (!controller.signal.aborted) controls();
      }
    }
    async function listImports() {
      const revision = ++receiptsRequest;
      history.textContent = t("common.pageLoading");
      try {
        const items = await api<MemoryArchiveImport[]>(path + "memory-import", "GET", undefined, controller.signal);
        if (controller.signal.aborted || revision !== receiptsRequest) return;
        savedImports = items;
        const dates = new Intl.DateTimeFormat(document.documentElement.lang, {
          dateStyle: "medium",
          timeStyle: "short",
        });
        setMessageHtml(
          history,
          items.length
            ? `${
                items.some((item) => !item.withdrawn && item.materials?.length)
                  ? `<p class="memory-native-copy-hint">${m("projects.memoryNativeCopyHint")}</p>`
                  : ""
              }<ul class="memory-package-imports">${items
                .map(
                  (item) =>
                    `<li><div><strong>${m("projects.memoryPackageSource")}</strong> <code data-i18n-ignore>${escape(item.packageId.slice(0, 8))}</code><br>
          <time>${escape(dates.format(item.importedAt))}</time></div>
          ${item.withdrawn ? `<span>${m("projects.memoryPackageWithdrawn")}</span>` : `<button type="button" class="wb-button" data-package-withdraw="${escape(item.packageId)}">${m("projects.memoryPackageWithdraw")}</button>`}
          ${
            item.withdrawn
              ? ""
              : memoryMaterialList(t, item.materials ?? [], {
                  path,
                  packageId: item.packageId,
                  destination: { project, copies: item.copies },
                })
          }</li>`,
                )
                .join("")}</ul>`
            : `<p>${m("projects.memoryPackageNoImports")}</p>`,
        );
      } catch (error) {
        if (!controller.signal.aborted && revision === receiptsRequest)
          history.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
      }
    }
    receipts.ontoggle = () => {
      if (receipts.open) void listImports();
    };
    bindMemoryNativeCopies(history, project, path, t, controller.signal);
    history.onclick = async (event) => {
      const target =
        event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-package-withdraw]") : null;
      if (!target || busy || controller.signal.aborted) return;
      if (
        !(await confirmAction({
          title: "projects.memoryPackageWithdraw",
          message: "projects.memoryPackageWithdrawHint",
          confirmText: "projects.memoryPackageWithdraw",
          cancelText: "common.cancel",
          returnFocus: target,
        }))
      )
        return;
      void run(async () => {
        await api(
          path + "memory-import-withdraw",
          "POST",
          { packageId: target.dataset.packageWithdraw },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        changed();
        status.textContent = t("projects.memoryPackageWithdrawn");
        await listImports();
      });
    };
    async function removeUpload(id: string, signal: AbortSignal) {
      const response = await request(uploadPath + "?" + new URLSearchParams({ upload: id }), {
        method: "DELETE",
        signal,
      });
      if (!response.ok && response.status !== 404) throw new Error(t("harness.errorUnavailable"));
    }
    function resetUpload() {
      if (uploadId && !remoteTask) void removeUpload(uploadId, AbortSignal.timeout(10_000)).catch(() => {});
      uploadId = undefined;
      remoteTask = undefined;
    }
    function clearSelection() {
      resetUpload();
      selected = preview = addressing = unlocked = undefined;
      password.value = "";
      delete picker.dataset.selected;
      shell.replaceChildren();
      transferRow.hidden = true;
      fileName.textContent = t("projects.memoryPackageChoose");
      fileName.removeAttribute("title");
      fileHint.textContent = t("projects.memoryPackageDropHint");
    }
    function showFile(name: string, bytes: number) {
      picker.dataset.selected = "";
      fileName.textContent = name;
      fileName.title = name;
      const size = new Intl.NumberFormat(document.documentElement.lang, { maximumFractionDigits: 1 });
      const mib = bytes >= 1024 * 1024;
      fileHint.textContent = t(mib ? "projects.memoryPackageSizeMb" : "projects.memoryPackageSizeKb", {
        size: size.format(bytes / (mib ? 1024 * 1024 : 1024)),
      });
    }
    function selectFile(candidate: File | undefined) {
      if (!candidate) return;
      void run(async () => {
        const resuming = remoteTask?.state === "uploading" && !selected ? remoteTask : undefined;
        if (!resuming) clearSelection();
        status.textContent = "";
        if (!candidate.name.toLowerCase().endsWith(memoryPackageExtension) || candidate.size < pmfMinimumBytes)
          throw new Error(t("projects.memoryPackageInvalid"));
        if (candidate.size > memoryPackageUploadMaxBytes) throw new Error(t("harness.errorContextTooLarge"));
        const envelope = await readMemoryPackageRecipient(candidate, t);
        if (
          resuming &&
          (resuming.size !== candidate.size ||
            resuming.name !== candidate.name ||
            (resuming.envelope && resuming.envelope !== envelope.envelope))
        )
          throw new Error(t("projects.memoryPackageResumeMismatch"));
        selected = candidate;
        showFile(candidate.name, candidate.size);
        addressing = envelope;
        if (!uploadsRemotely() && !addressing.recipient) status.textContent = t("projects.memoryPackageMissingKey");
      });
    }
    const queue = memoryPackageQueue(
      queueSection,
      uploadPath,
      controller.signal,
      t,
      (enabled) => {
        remoteMode = enabled;
        controls();
      },
      (task) => {
        if (busy) return;
        clearSelection();
        remoteTask = task;
        uploadId = task.id;
        showFile(task.name, task.size);
        status.textContent = "";
        if (task.state === "awaiting-key" && task.envelope) {
          addressing = readMemoryPackageEnvelope(decodeBase64Url(task.envelope), t);
          if (!addressing.recipient) status.textContent = t("projects.memoryPackageMissingKey");
        } else {
          status.textContent = t("projects.memoryPackageResumeHint");
        }
        controls();
        if (!unlock.hidden) password.focus({ preventScroll: true });
        else picker.focus({ preventScroll: true });
      },
      async (task) => {
        if (busy) return;
        await removeUpload(task.id, controller.signal);
        if (task.id === uploadId) clearSelection();
        controls();
      },
    );
    void queue.refresh();
    password.oninput = controls;
    picker.onclick = () => file.click();
    file.onchange = () => {
      selectFile(file.files?.[0]);
      file.value = "";
    };
    picker.ondragover = (event) => {
      event.preventDefault();
      if (!busy && event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
        picker.dataset.dragging = "";
      }
    };
    picker.ondragleave = () => delete picker.dataset.dragging;
    picker.ondrop = (event) => {
      event.preventDefault();
      delete picker.dataset.dragging;
      selectFile(event.dataTransfer?.files[0]);
    };
    stop.onclick = () => transfer?.abort();

    async function prepareUpload(candidate: File, signal: AbortSignal) {
      if (uploadId) {
        try {
          return await api<MemoryPackageUpload>(
            uploadPath + "?" + new URLSearchParams({ upload: uploadId }),
            "GET",
            undefined,
            signal,
          );
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "notFound") throw error;
        }
      }
      const next = await api<MemoryPackageUpload>(
        uploadPath,
        "POST",
        { name: candidate.name, size: candidate.size },
        signal,
      );
      uploadId = next.id;
      return next;
    }
    review.onclick = () =>
      void run(async () => {
        const candidate = selected;
        const current = new AbortController();
        const signal = AbortSignal.any([current.signal, controller.signal]);
        const passphrase = password.value;
        preview = undefined;
        shell.replaceChildren();
        let result: MemoryArchivePreview;
        try {
          if (candidate) {
            const cloud = uploadsRemotely();
            if (!cloud && !addressing?.recipient) return;
            if (!cloud && addressing?.recipient) {
              unlocked = await unwrapMemoryPackageKey(addressing.recipient, addressing.wrapped, passphrase, t);
              signal.throwIfAborted();
            }
            const stage = await prepareUpload(candidate, signal);
            if (stage.remote) remoteTask = stage as MemoryPackageTransfer;
            else if (cloud) {
              // Storage can change between file selection and upload admission.
              status.textContent = "";
              return;
            }
            const format = new Intl.NumberFormat(document.documentElement.lang, { style: "percent" });
            const updateProgress = (bytes: number) => {
              const fraction = Math.floor((bytes * 100) / candidate.size);
              progress.value = fraction;
              percentText.textContent = format.format(fraction / 100);
            };
            transfer = current;
            transferRow.hidden = false;
            updateProgress(0);
            status.textContent = "";
            controls();
            await uploadMemoryPackage(uploadPath, candidate, stage, signal, updateProgress, t);
            if (stage.remote) {
              clearSelection();
              status.textContent = t("projects.memoryPackageQueuedHint");
              await queue.refresh();
              return;
            }
          } else if (remoteTask?.state === "awaiting-key" && addressing?.recipient) {
            unlocked = await unwrapMemoryPackageKey(addressing.recipient, addressing.wrapped, passphrase, t);
            signal.throwIfAborted();
          }
          if (!unlocked) return;
          status.textContent = t("projects.memoryPackageChecking");
          result = await api<MemoryArchivePreview>(
            path + "memory-import-preview",
            "POST",
            { uploadId, unlock: unlocked },
            signal,
          );
        } catch (error) {
          if (!current.signal.aborted) throw error;
          status.textContent = t("projects.memoryPackageUploadStopped");
          if (remoteTask) await queue.refresh();
          return;
        } finally {
          transfer = undefined;
          transferRow.hidden = true;
        }
        if (controller.signal.aborted) return;
        preview = result;
        password.value = "";
        status.textContent = result.withdrawn
          ? t("projects.memoryPackageWithdrawn")
          : result.imported
            ? t("projects.memoryPackageAlreadyImported")
            : result.materials?.length && !result.records.length && !result.invalid
              ? ""
              : summary(result);
        setMessageHtml(
          shell,
          `<ul class="memory-package-preview-list">${result.records
            .map(
              (record) =>
                `<li><div><strong data-i18n-ignore>${escape(record.key)}</strong> <code data-i18n-ignore>${escape(record.scope)}</code>
        <span>${m(actions[record.action])}</span></div>
        <ul>${record.values.map((value) => `<li data-i18n-ignore>${escape(value)}</li>`).join("")}</ul></li>`,
            )
            .join("")}</ul>${memoryMaterialList(t, result.materials ?? [])}`,
        );
      });
    form.onsubmit = (event) => {
      event.preventDefault();
      if (!preview || submit.disabled) return;
      const token = preview.token;
      void run(async () => {
        try {
          const result = await api<MemoryArchiveImport>(
            path + "memory-import",
            "POST",
            { uploadId, token, unlock: unlocked },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          const importedRemote = remoteTask?.id;
          clearSelection();
          if (importedRemote)
            void removeUpload(importedRemote, AbortSignal.timeout(10_000)).then(queue.refresh, queue.refresh);
          changed();
          status.textContent = summary(result);
          if (receipts.open) await listImports();
          else receipts.open = true;
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "conflict") {
            preview = undefined;
            shell.replaceChildren();
            throw new Error(t("projects.memoryPackageChanged"), { cause: error });
          }
          throw error;
        }
      });
    };
    dialog.addEventListener(
      "close",
      () => {
        unlocked = undefined;
        password.value = "";
        resetUpload();
      },
      { once: true },
    );
  }

  function showExport(project: string, trigger: HTMLElement) {
    let keys: KeyBackup[] = [];
    try {
      keys = listEncryptionKeys();
    } catch {}
    const { dialog, controller } = open(
      "projects.memoryPackageExportTitle",
      trigger,
      `<section class="memory-package-body">
        <p>${m(keys.length ? "projects.memoryPackageExportHint" : "projects.memoryPackageMissingKey")}</p>
        ${
          keys.length > 1
            ? `<label class="wb-field"><span>${m("settings.encryptionKeys")}</span>
          <select>${keys.map((key) => `<option value="${key.fingerprint}" data-i18n-ignore>${escape(key.name)} · ${key.fingerprint.slice(0, 8)}</option>`).join("")}</select></label>`
            : ""
        }
        ${
          keys.length
            ? `<details class="memory-package-material-picker" data-package-material-picker>
          <summary>${m("projects.memoryMaterialTitle")} <span data-material-count role="status"></span></summary>
          <label class="wb-field"><span>${m("projects.memoryMaterialType")}</span><select data-material-type>
            <option value="files">${m("projects.memoryMaterialFiles")}</option>
            <option value="document">${m("projects.memoryMaterialDocuments")}</option>
          </select></label>
          <div class="memory-package-material-options" data-material-options></div>
          <button type="button" class="wb-button" data-material-more hidden>${m("projects.memoryMore")}</button>
        </details>`
            : ""
        }
        <p role="status" data-memory-package-status></p>
        <div class="memory-package-actions">
          ${keys.length ? `<button type="button" class="wb-button primary" data-memory-package-export>${codexIcon("download")}${m("projects.memoryPackageExport")}</button>` : `<a href="${keySettingsPath}" class="wb-button">${m("settings.encryptionKeys")}</a>`}
        </div>
      </section>`,
    );
    const button = dialog.querySelector<HTMLButtonElement>("[data-memory-package-export]");
    const status = dialog.querySelector<HTMLElement>("[data-memory-package-status]")!;
    const select = dialog.querySelector<HTMLSelectElement>("select:not([data-material-type])");
    if (!button) return;
    const picker = dialog.querySelector<HTMLDetailsElement>("[data-package-material-picker]")!;
    const path = "/api/projects/" + encodeURIComponent(project) + "/";
    const selected = memoryMaterialPicker(
      path + "memory-materials",
      picker,
      controller.signal,
      t,
      memoryCitationEditor(dialog, path, t, controller.signal),
    );
    button.onclick = async () => {
      const key = select ? keys.find((item) => item.fingerprint === select.value) : keys[0];
      if (!key) return;
      button.disabled = true;
      status.textContent = t("common.pageLoading");
      try {
        await downloadMemoryPackage(
          "/api/projects/" + encodeURIComponent(project) + "/memory-export",
          key,
          controller.signal,
          t,
          selected(),
        );
        status.textContent = t("projects.memoryPackageExported");
      } catch (error) {
        if (!controller.signal.aborted)
          status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
      } finally {
        if (!controller.signal.aborted) button.disabled = false;
      }
    };
  }

  function showReferences(project: string, trigger: HTMLButtonElement) {
    const { packageSource: packageId, memoryKey: key, memoryScope: scope } = trigger.dataset;
    if (!packageId || !key || !scope) return;
    const path = "/api/projects/" + encodeURIComponent(project) + "/";
    const { dialog, controller } = open(
      "projects.memoryMaterialReferences",
      trigger,
      `<section class="memory-package-body"><p role="status">${m("common.pageLoading")}</p><div data-reference-materials></div></section>`,
    );
    const status = dialog.querySelector<HTMLElement>('[role="status"]')!;
    const results = dialog.querySelector<HTMLElement>("[data-reference-materials]")!;
    void api<MemoryArchiveImport>(
      path + "memory-import?" + new URLSearchParams({ package: packageId }),
      "GET",
      undefined,
      controller.signal,
    )
      .then((receipt) => {
        if (controller.signal.aborted) return;
        const files = receipt.materials ?? [];
        status.textContent = files.length ? "" : t("projects.memoryMaterialNoLocation");
        setMessageHtml(results, memoryMaterialList(t, files, { path, packageId, reference: { key, scope } }));
        bindMemoryMaterialList(
          results,
          () => files,
          memoryPackageReader(dialog, path, t, controller.signal),
          controller.signal,
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
      });
  }

  function showMaterial(project: string, hit: Omit<MemoryMaterialHit, "excerpt">, trigger: HTMLElement) {
    const { dialog, controller } = open(
      "projects.memoryMaterialTitle",
      trigger,
      '<section class="memory-package-body"></section>',
    );
    const path = "/api/projects/" + encodeURIComponent(project) + "/";
    memoryPackageReader(dialog, path, t, controller.signal, close)(
      trigger,
      hit.packageId,
      hit.material,
      hit.file,
      hit.location,
    );
  }

  return { showImport, showExport, showReferences, showMaterial, close };
}
