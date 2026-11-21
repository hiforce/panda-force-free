import { LazyCreativeAssetsPanel } from "../creative/assets-lazy.js";
import { createRuntimeModelField } from "../harness/model-field.js";
import type { CreationAvailability, CreationTaskView, CreationArtifact } from "../../shared/creation/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { setMessageHtml, errorText } from "../i18n.js";

import { creationApiFor, CreationApiError } from "./api.js";
import { CreationDrafts } from "./drafts.js";
import { CreationSubmission } from "./submission.js";
import { CreationSkills } from "./skills.js";
import { CreationCards } from "./cards.js";
import { creationFrame, creationLoadingFrame, type CreationLocation } from "./views.js";
import { defaultCreationOutput } from "../../shared/creation/default-output.js";

export interface CreationContext {
  projectId: string;
  treeVersion(): number;
  locations: CreationLocation[];
  parentId: string | null;
  open(documentId: string): Promise<void>;
  openArtifact?(artifact: Exclude<CreationArtifact, { kind: "document" }>): Promise<void>;
  manual(parentId: string | null): Promise<void>;
  history?: boolean;
  prompt?: string;
  submitOnOpen?: boolean;
  closed?(): void;
}
/** Owns one project panel and its fetch generation. Draft identity, skill fields and task cards have separate owners. */
export class DocumentCreationPanel {
  private modelFields?: ReturnType<typeof createRuntimeModelField>;
  private epoch = 0;
  private reads = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private skills: CreationSkills | null = null;
  private cards: CreationCards | null = null;
  private afterClose: (() => void) | undefined;
  private readonly assets: LazyCreativeAssetsPanel;
  constructor(
    private readonly t: Translate,
    private readonly identity: string,
    private readonly dialog: HTMLDialogElement = document.createElement("dialog"),
  ) {
    this.dialog.id = document.getElementById("projectDocumentCreation")
      ? "projectDocumentCreation-" + crypto.randomUUID()
      : "projectDocumentCreation";
    this.assets = new LazyCreativeAssetsPanel(t, this.dialog.id + "Assets", identity);
    this.dialog.className = "creation-dialog";
    document.body.append(this.dialog);
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.dialog.addEventListener("click", (event) => {
      if ((event.target as Element).closest("[data-creation-close]")) this.close();
    });
  }
  close() {
    const closed = this.afterClose;
    this.afterClose = undefined;
    this.epoch++;
    this.reads++;
    clearTimeout(this.timer);
    this.assets.close();
    this.modelFields?.close();
    this.modelFields = undefined;
    this.cards?.dispose();
    this.cards = null;
    this.skills?.close();
    this.skills = null;
    this.dialog.close();
    this.dialog.replaceChildren();
    closed?.();
  }
  async open(context: CreationContext) {
    this.close();
    this.afterClose = context.closed;
    const creationApi = creationApiFor(context.projectId);
    const epoch = this.epoch,
      current = () => epoch === this.epoch && this.dialog.open;
    setMessageHtml(this.dialog, creationLoadingFrame(this.t));
    this.dialog.showModal();
    let options: CreationAvailability;
    try {
      options = await creationApi.options();
    } catch {
      options = { state: "unavailable", profiles: [], defaultProfileId: null, defaultWorkflow: null, capabilities: [] };
    }
    if (!current()) return;
    const store = new CreationDrafts(this.identity, context.projectId),
      saved = store.load(),
      valid = saved && (!saved.pending || saved.pending.projectId === context.projectId),
      submission = new CreationSubmission(
        valid
          ? saved
          : {
              prompt: "",
              profileId: options.defaultProfileId ?? "",
              parentId: context.parentId,
              selections: [],
              skillsVersion: 2,
              pending: null,
            },
        store,
        creationApi,
      ),
      get = <T extends HTMLElement>(selector: string) => this.dialog.querySelector<T>(selector)!;
    const modelFields = createRuntimeModelField(this.t, "creation", () => remember());
    this.modelFields = modelFields;
    setMessageHtml(
      this.dialog,
      creationFrame(this.t, options, context.locations, context.projectId === "personal", modelFields.html()),
    );
    const form = get<HTMLFormElement>("form.creation-compose"),
      prompt = get<HTMLTextAreaElement>('[name="prompt"]'),
      profile = get<HTMLSelectElement>('[name="profileId"]'),
      parent = get<HTMLSelectElement>('[name="parentId"]'),
      submit = get<HTMLButtonElement>("[data-creation-submit]");
    if (context.prompt !== undefined && !submission.state.pending) submission.state.prompt = context.prompt;
    if (!submission.state.profileId) submission.state.profileId = options.defaultProfileId || "";
    prompt.value = submission.state.prompt;
    profile.value = submission.state.profileId;
    parent.value = submission.state.parentId ?? "";
    let busy = false,
      tasks: CreationTaskView[] = [],
      focusedTask = "",
      revealHistory = context.history === true;
    const direct = context.submitOnOpen === true;
    form.hidden = direct;
    if (direct) {
      get(".creation-heading h2").textContent = this.t("projects.draftProgress");
      get(".creation-heading p").textContent = this.t("projects.draftProgressHint");
      get(".creation-history h3").textContent = this.t("projects.currentDraft");
      get(".creation-history").hidden = true;
    }
    const notice = (text: string, failed = false) => {
        if (!current()) return;
        const node = get("[data-creation-notice]");
        node.hidden = !text;
        node.textContent = text;
        node.dataset.error = String(failed);
      },
      report = (error: unknown) =>
        notice(
          errorText(error instanceof CreationApiError ? error.payload : null, this.t, "creation.taskActionFailed"),
          true,
        ),
      controls = () => {
        if (!current()) return;
        const pending = !!submission.state.pending;
        for (const field of [prompt, profile, parent]) field.disabled = busy || pending;
        this.skills?.setLocked(busy || pending);
        modelFields.setLocked(busy || pending);
        submit.disabled = busy || (!pending && options.state !== "ready");
        submit.textContent = this.t(
          busy ? "creation.creating" : pending ? "creation.retrySubmission" : "creation.create",
        );
      },
      remember = () => {
        if (current() && !busy)
          submission.remember({
            prompt: prompt.value,
            profileId: profile.value,
            ...modelFields.read(),
            parentId: parent.value || null,
            selections: this.skills?.read() ?? [],
          });
      },
      merge = (task?: CreationTaskView) => {
        this.reads++;
        if (!current() || !task) return;
        tasks = [task, ...tasks.filter((value) => value.id !== task.id)].sort((a, b) => b.createdAt - a.createdAt);
        cards.render(direct ? tasks.filter((value) => value.id === focusedTask) : tasks);
      },
      cards = new CreationCards(
        get("[data-creation-tasks]"),
        this.t,
        merge,
        (artifact) => {
          this.close();
          if (artifact.kind === "document") void context.open(artifact.documentId).catch(report);
          else if (context.openArtifact) void context.openArtifact(artifact).catch(report);
          else
            void this.assets
              .follow(artifact.projectId, artifact.assetId, async () => {}, artifact.version)
              .catch(report);
        },
        report,
        creationApi,
      );
    this.cards = cards;
    this.skills = new CreationSkills(
      get("[data-creation-skills]"),
      this.t,
      submission.state.selections,
      options.capabilities,
      () => {
        remember();
        controls();
      },
      report,
    );
    form.oninput = remember;
    form.onchange = remember;
    get<HTMLButtonElement>("[data-creation-manual]").onclick = () => {
      const target = parent.value || null;
      this.close();
      void context.manual(target);
    };
    const refresh = async () => {
      clearTimeout(this.timer);
      const read = ++this.reads;
      try {
        if (direct && !focusedTask) return;
        const result = direct
          ? { tasks: [(await creationApi.progress(focusedTask)).task] }
          : await creationApi.list(context.projectId);
        if (current() && read === this.reads) {
          tasks = result.tasks;
          cards.render(direct ? tasks.filter((value) => value.id === focusedTask) : tasks);
          if (revealHistory) {
            revealHistory = false;
            get(".creation-history").scrollIntoView({ block: "start" });
          }
        }
      } catch (error) {
        if (current() && read === this.reads) report(error);
      } finally {
        if (current())
          this.timer = setTimeout(
            () => void refresh(),
            document.visibilityState === "hidden"
              ? 10000
              : tasks.some((task) => ["queued", "running", "committing"].includes(task.state))
                ? 1000
                : 5000,
          );
      }
    };
    get<HTMLButtonElement>("[data-creation-refresh]").onclick = () => void refresh();
    const send = async () => {
      if (busy || submit.disabled) return;
      if (!submission.state.pending) {
        await modelReady;
        if (!modelFields.ready()) {
          report(new Error(this.t("harness.selectionError")));
          return;
        }
      }
      if (!submission.state.pending) {
        if (!form.checkValidity()) {
          form.hidden = false;
          const invalid = form.querySelector<HTMLElement>(":invalid");
          const details = invalid?.closest("details");
          if (details) details.open = true;
          form.reportValidity();
          return;
        }
        remember();
      }
      busy = true;
      controls();
      this.reads++;
      try {
        const task = await submission.send(() => {
          const { prompt, profileId, parentId, selections } = submission.state;
          return {
            prompt,
            profileId,
            runtimeId: submission.state.runtimeId,
            ...(submission.state.model ? { model: submission.state.model } : {}),
            ...(submission.state.effort ? { effort: submission.state.effort } : {}),
            parentId,
            selections,
            outputType: defaultCreationOutput(options),
            id: crypto.randomUUID(),
            projectId: context.projectId,
            treeVersion: context.treeVersion(),
            locale: document.documentElement.lang || "en",
          };
        });
        if (!current()) return;
        if (!submission.state.profileId) submission.state.profileId = options.defaultProfileId || "";
        prompt.value = submission.state.prompt;
        this.skills?.setSelected(submission.state.selections, true);
        focusedTask = task.id;
        get(".creation-history").hidden = false;
        merge(task);
        notice(this.t("creation.submitted"));
        get(`[data-creation-task="${task.id}"]`).scrollIntoView({ block: "start" });
        if (direct) void refresh();
      } catch (error) {
        if (current()) {
          form.hidden = false;
          notice(
            submission.state.pending
              ? this.t("creation.deliveryUncertain")
              : errorText(
                  error instanceof CreationApiError ? error.payload : null,
                  this.t,
                  "creation.taskActionFailed",
                ),
            true,
          );
        }
      } finally {
        busy = false;
        controls();
      }
    };
    const modelReady = modelFields.mount(form, {
      runtimeId: submission.state.runtimeId,
      model: submission.state.model,
      effort: submission.state.effort,
    });
    form.onsubmit = (event) => {
      event.preventDefault();
      void send();
    };
    controls();
    if (options.state !== "ready") {
      form.hidden = false;
      notice(this.t("creation.unavailable"));
    } else if (saved?.prompt && context.prompt === undefined) notice(this.t("creation.briefRecovered"));
    if (!direct) void refresh();
    if (submission.state.pending) {
      const accepted = await submission.confirm();
      if (current() && accepted) {
        if (!submission.state.profileId) submission.state.profileId = options.defaultProfileId || "";
        prompt.value = submission.state.prompt;
        this.skills?.setSelected(submission.state.selections, true);
        focusedTask = accepted.id;
        get(".creation-history").hidden = false;
        merge(accepted);
        controls();
        if (direct) void refresh();
      } else if (current() && direct) await send();
    } else if (direct && options.state === "ready") await send();
    else prompt.focus({ preventScroll: true });
  }
}
