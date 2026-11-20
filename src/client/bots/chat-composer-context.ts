import type { ComposerAttachment } from "../../shared/data-contracts.js";
import type { CreationSkillSelection } from "../../shared/creation/contracts.js";
import { DOCUMENT_CREATION_CAPABILITIES } from "../../shared/creation/contracts.js";
import type { BotContext } from "./ui.js";
import type { BotChatSubmission } from "../../shared/bots/workspace.js";
import { request } from "../http-client.js";
import { createComposerAddMenu } from "../composer-add-menu.js";
import { renderComposerAttachmentTray } from "../composer-attachment-view.js";
import { createComposerContexts } from "../message-composer-contexts.js";
import { composerSkillButton } from "../composer-skill-button.js";
import { CreationSkills } from "../creation/skills.js";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, filesFromClipboard } from "../composer-attachments.js";
import { setMessageHtml } from "../i18n.js";
import { documentJson } from "../documents/api.js";

export interface BotComposerDraft {
  attachments?: ComposerAttachment[];
  selections?: CreationSkillSelection[];
  project?: string;
  sources?: Map<string, () => Promise<File>>;
}

/** Bot inputs share material and skill views, while retaining their own draft, upload and execution boundaries. */
export function createBotComposerContext(
  form: HTMLFormElement,
  draft: BotComposerDraft,
  context: BotContext,
  changed: () => void,
) {
  const t = context.t,
    input = form.querySelector<HTMLTextAreaElement>("[data-message]")!,
    picker = form.querySelector<HTMLInputElement>("[data-chat-files]")!,
    add = form.querySelector<HTMLButtonElement>("[data-composer-control=add]")!,
    tray = form.querySelector<HTMLElement>(".composer-attachments")!,
    selected = form.querySelector<HTMLElement>(".creative-selected-skills")!,
    skillControl = document.createElement("div"),
    events = new AbortController();
  draft.attachments ??= [];
  draft.selections ??= [];
  draft.sources ??= new Map();
  let alive = true,
    locked = false,
    skills: CreationSkills | undefined;
  setMessageHtml(skillControl, composerSkillButton(t, "data-session-skills", "bots.chatDeliveryHint"));
  const skillButton = skillControl.querySelector<HTMLButtonElement>("[data-composer-skill-trigger]")!;
  function skillPicker() {
    skills ??= new CreationSkills(
      selected,
      t,
      draft.selections ?? [],
      DOCUMENT_CREATION_CAPABILITIES,
      () => {
        draft.selections = skills!.read();
        changed();
      },
      () => {},
      "composer",
    );
    return skills;
  }
  skillButton.onclick = () => skillPicker().browse(add);
  form.addEventListener("composer:browse-skills", () => skillButton.click(), { signal: events.signal });
  if (draft.selections.length) skillPicker();
  function render() {
    if (!alive) return;
    renderComposerAttachmentTray({
      host: tray,
      attachments: draft.attachments ?? [],
      t,
      source: (attachment) =>
        attachment.materialId ? "/api/chat-materials/original?id=" + encodeURIComponent(attachment.materialId) : "",
      preview: (source) => window.open(source, "_blank", "noopener,noreferrer"),
      remove(id) {
        if (locked) return;
        draft.attachments = draft.attachments?.filter((entry) => entry.id !== id);
        draft.sources?.delete(id);
        render();
        input.focus({ preventScroll: true });
      },
      retry(id) {
        const attachment = draft.attachments?.find((entry) => entry.id === id),
          load = draft.sources?.get(id);
        if (!locked && attachment && load) void upload(attachment, load);
      },
    });
    for (const button of tray.querySelectorAll<HTMLButtonElement>("button")) button.disabled = locked;
    rails.refresh();
    changed();
  }
  async function upload(attachment: ComposerAttachment, load: () => Promise<File>) {
    attachment.status = "uploading";
    render();
    try {
      const file = await load();
      if (!file.size || file.size > ATTACHMENT_MAX_BYTES) throw new Error("size");
      const response = await request("/api/chat-materials?" + new URLSearchParams({ name: file.name }), {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: file,
          signal: AbortSignal.timeout(120000),
        }),
        value = await response.json();
      if (!response.ok || !value.attachment?.materialId) throw new Error("upload");
      if (!draft.attachments?.includes(attachment)) return;
      Object.assign(attachment, value.attachment, { id: attachment.id });
      draft.sources?.delete(attachment.id);
    } catch {
      if (!draft.attachments?.includes(attachment)) return;
      attachment.status = "failed";
      if (alive) context.notice(t("common.uploadFailed"));
    }
    render();
  }
  function attach(name: string, load: () => Promise<File>) {
    if (!alive || locked) return;
    if ((draft.attachments?.length ?? 0) >= ATTACHMENT_MAX_COUNT) {
      context.notice(t("composer.youCanAttachUpTo10Files"));
      return;
    }
    const attachment = { id: crypto.randomUUID(), name, kind: "file", status: "uploading" };
    draft.attachments!.push(attachment);
    draft.sources!.set(attachment.id, load);
    void upload(attachment, load);
  }
  function files(values: FileList | File[] | null) {
    for (const file of Array.from(values ?? [])) {
      if (!file.size || file.size > ATTACHMENT_MAX_BYTES) {
        context.notice(t(file.size ? "composer.eachAttachmentMustBe25MibOrSmaller" : "errors.cannotUploadAnEmptyFile"));
        continue;
      }
      attach(file.name, () => Promise.resolve(file));
    }
  }
  const menu = createComposerAddMenu({
    trigger: add,
    skills: skillControl,
    input: picker,
    t,
    attach,
    project: () => draft.project ?? "personal",
    projects: {
      async load(signal) {
        const value = await documentJson<{ projects: { id: string; name: string }[] }>(
          "/api/projects",
          "GET",
          undefined,
          signal,
        );
        return [
          { id: "personal", name: t("common.personal") },
          ...value.projects.filter((entry) => entry.id !== "personal"),
        ];
      },
      select: (id) => {
        draft.project = id;
      },
    },
  });
  const rails = createComposerContexts(form, form.querySelector<HTMLElement>(".message-composer-body")!, t);
  picker.addEventListener(
    "change",
    () => {
      files(picker.files);
      picker.value = "";
    },
    { signal: events.signal },
  );
  input.addEventListener(
    "paste",
    (event) => {
      const pasted = filesFromClipboard(event.clipboardData);
      if (pasted.length) {
        event.preventDefault();
        files(pasted);
      }
    },
    { signal: events.signal },
  );
  form.addEventListener(
    "dragover",
    (event) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    },
    { signal: events.signal },
  );
  form.addEventListener(
    "drop",
    (event) => {
      if (event.dataTransfer?.files.length) {
        event.preventDefault();
        files(event.dataTransfer.files);
      }
    },
    { signal: events.signal },
  );
  render();
  return {
    ready: () => (draft.attachments ?? []).every((entry) => entry.status === "ready" && entry.materialId),
    read: () => ({
      attachments: (draft.attachments ?? []).map((entry) => ({ materialId: entry.materialId! })),
      selections: skills?.read() ?? draft.selections ?? [],
    }),
    lock(value: boolean) {
      if (locked === value) return;
      locked = value;
      add.disabled = value;
      if (value) menu.close(false);
      skills?.setLocked(value);
      for (const button of tray.querySelectorAll<HTMLButtonElement>("button")) button.disabled = value;
    },
    clear() {
      draft.attachments = [];
      draft.selections = [];
      draft.sources?.clear();
      skills?.setSelected([]);
      render();
    },
    accepted(body: BotChatSubmission) {
      const sent = new Set((body.attachments ?? []).map((entry) => entry.materialId));
      draft.attachments = draft.attachments?.filter((entry) => !sent.has(entry.materialId ?? ""));
      if (JSON.stringify(draft.selections ?? []) === JSON.stringify(body.selections ?? [])) {
        draft.selections = [];
        skills?.setSelected([]);
      }
      render();
    },
    dispose() {
      alive = false;
      events.abort();
      menu.dispose();
      rails.dispose();
      skills?.close();
    },
  };
}
