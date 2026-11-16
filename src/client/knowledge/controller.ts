import type { Translate } from "../../shared/i18n/messages.js";
import type { KnowledgeTask } from "../../shared/knowledge/tasks.js";
import { setMessageHtml } from "../i18n.js";
import { knowledgeApi, knowledgeRequest, KnowledgeApiError } from "./api.js";
import { knowledgeFrame, knowledgeTasksHtml, type KnowledgePanelContext } from "./views.js";
import { KnowledgeTaskDetailView } from "./task-detail.js";
import { KnowledgeReviewPreference } from "./preference.js";
import { KnowledgeSubmission } from "./submission.js";
import { KnowledgeGenerationView } from "./generation.js";
import { KnowledgeSourcePicker } from "./source-picker.js";

/** The panel owns a view lifetime; tasks continue in their dedicated channel when it is closed. */
export class KnowledgePanel {
  private readonly dialog = document.createElement("dialog");
  private lifetime: AbortController | null = null;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private previous: Element | null = null;
  constructor(
    private readonly t: Translate,
    private readonly identity: string,
  ) {
    this.dialog.className = "workbench-dialog knowledge-panel";
    this.dialog.id = "knowledgePanel-" + crypto.randomUUID();
    this.dialog.setAttribute("aria-label", t("knowledge.title"));
    document.body.append(this.dialog);
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.dialog.addEventListener("click", (event) => {
      if ((event.target as Element).closest("[data-knowledge-close],a[data-wb=route]")) this.close();
    });
  }
  close() {
    this.lifetime?.abort();
    this.lifetime = null;
    clearTimeout(this.poll);
    this.dialog.close();
    this.dialog.replaceChildren();
    if (this.previous instanceof HTMLElement && this.previous.isConnected) this.previous.focus({ preventScroll: true });
  }
  async open(context: KnowledgePanelContext) {
    this.close();
    this.previous = document.activeElement;
    const lifetime = new AbortController(),
      { signal } = lifetime;
    this.lifetime = lifetime;
    setMessageHtml(this.dialog, knowledgeFrame(this.t));
    this.dialog.showModal();
    const get = <T extends HTMLElement>(selector: string) => this.dialog.querySelector<T>(selector)!,
      notice = (text: string) => {
        if (!signal.aborted) get("[data-knowledge-notice]").textContent = text;
      },
      report = (error: unknown) =>
        notice(
          this.t(
            error instanceof KnowledgeApiError && error.code === "contextLimit"
              ? "knowledge.contextLimit"
              : error instanceof KnowledgeApiError && error.code === "budget"
                ? "knowledge.rulesBudget"
                : error instanceof KnowledgeApiError && error.code === "conflict"
                  ? "knowledge.conflict"
                  : error instanceof KnowledgeApiError && error.code === "invalidInput"
                    ? "knowledge.invalidInput"
                    : "knowledge.unavailable",
          ),
        ),
      submission = new KnowledgeSubmission(this.identity, context.project),
      form = get<HTMLFormElement>("[data-knowledge-compose]"),
      purpose = form.elements.namedItem("pf-knowledge-purpose") as HTMLTextAreaElement,
      submit = get<HTMLButtonElement>("[data-knowledge-submit]");
    if (submission.pending) purpose.value = submission.pending.purpose;
    let tasks: KnowledgeTask[] = [],
      selectedTask = "",
      available = false,
      busy = false,
      listRead: AbortController | null = null,
      sequence = 0,
      polls = 0,
      listSignature = "",
      pageIndex = 0,
      cursors: (string | undefined)[] = [undefined],
      nextCursor: string | null = null,
      pageLoading = false;
    const controls = () => {
      const pending = !!submission.pending;
      purpose.disabled = !available || busy || pending;
      sourcePicker.setDisabled(!available || busy || pending);
      submit.disabled = !available || busy || (!pending && (!sourcePicker.ready || !sourcePicker.selection.ids.length));
      submit.textContent = this.t(pending ? "knowledge.retrySubmission" : "knowledge.start");
    };
    const sourcePicker = new KnowledgeSourcePicker(this.dialog, context, this.t, signal, submission.pending, controls);
    const detail = new KnowledgeTaskDetailView(
        get("[data-knowledge-detail]"),
        this.t,
        signal,
        (task) => {
          sequence++;
          listRead?.abort();
          merge(task);
          schedule();
        },
        report,
      ),
      preference = new KnowledgeReviewPreference(
        this.dialog,
        context.project,
        this.t,
        signal,
        () => {
          notice(this.t("knowledge.policySaved"));
          void refresh();
        },
        report,
      );
    const generation = new KnowledgeGenerationView(
      get("[data-knowledge-rule-view]"),
      context.project,
      this.t,
      signal,
      () => {
        sequence++;
        listRead?.abort();
        void refresh();
      },
    );
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>("[data-knowledge-section]")) {
      button.onclick = () => {
        const rules = button.dataset.knowledgeSection === "rules";
        get("[data-knowledge-task-view]").hidden = rules;
        get("[data-knowledge-rule-view]").hidden = !rules;
        for (const other of this.dialog.querySelectorAll<HTMLButtonElement>("[data-knowledge-section]"))
          other.setAttribute("aria-pressed", String(other === button));
        if (rules) void generation.open().catch(report);
        else generation.hide();
        get(".knowledge-scroll").scrollTop = 0;
      };
    }
    const drawTasks = (selectCurrent = true) => {
      const signature = JSON.stringify([tasks, selectedTask]);
      if (signature === listSignature) return;
      listSignature = signature;
      setMessageHtml(get("[data-knowledge-tasks]"), knowledgeTasksHtml(tasks, selectedTask, this.t));
      for (const button of this.dialog.querySelectorAll<HTMLButtonElement>("[data-knowledge-task]"))
        button.onclick = () => {
          const task = tasks.find((task) => task.id === button.dataset.knowledgeTask)!;
          selectedTask = task.id;
          drawTasks(false);
          void detail
            .select(task)
            .then(() => {
              if (
                signal.aborted ||
                selectedTask !== task.id ||
                get("[data-knowledge-task-view]").hidden ||
                !matchMedia("(max-width: 700px)").matches
              )
                return;
              get("[data-knowledge-detail]").scrollIntoView({ block: "start" });
              get("[data-knowledge-detail]").focus({ preventScroll: true });
            })
            .catch(report);
        };
      const current = tasks.find((task) => task.id === selectedTask);
      if (current && selectCurrent) void detail.select(current).catch(report);
    };
    const merge = (task: KnowledgeTask) => {
      if (signal.aborted) return;
      tasks = [task, ...tasks.filter((other) => other.id !== task.id)]
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .slice(0, 50);
      selectedTask ||= task.id;
      drawTasks();
    };
    const schedule = () => {
      clearTimeout(this.poll);
      if (signal.aborted || polls >= 400) return;
      const working = tasks.some(
        (task) =>
          ["queued", "running", "committing"].includes(task.state) ||
          (task.state === "review" &&
            !task.manualReviewRequired &&
            preference.automatic &&
            (!task.automaticReview || task.automaticReview.state === "running")),
      );
      this.poll = setTimeout(
        () => {
          polls++;
          void refresh();
        },
        document.visibilityState === "hidden" ? 15000 : working ? 1500 : 8000,
      );
    };
    const pageControls = () => {
      get("[data-knowledge-pages]").hidden = pageIndex === 0 && !nextCursor;
      get<HTMLButtonElement>("[data-knowledge-newer]").disabled = pageLoading || pageIndex === 0;
      get<HTMLButtonElement>("[data-knowledge-older]").disabled = pageLoading || !nextCursor;
    };
    const refresh = async () => {
      clearTimeout(this.poll);
      listRead?.abort();
      const current = ++sequence,
        read = new AbortController();
      listRead = read;
      pageLoading = true;
      pageControls();
      try {
        const response = await knowledgeApi.list(
          context.project,
          AbortSignal.any([signal, read.signal]),
          cursors[pageIndex],
        );
        if (signal.aborted || current !== sequence) return;
        tasks = response.tasks;
        nextCursor = response.nextCursor ?? null;
        selectedTask ||= tasks[0]?.id ?? "";
        drawTasks();
        schedule();
      } catch (error) {
        if (!signal.aborted && !read.signal.aborted) report(error);
      } finally {
        if (!signal.aborted && current === sequence) {
          pageLoading = false;
          pageControls();
        }
      }
    };
    get("[data-knowledge-newer]").onclick = () => {
      if (pageLoading || pageIndex === 0) return;
      if (!detail.canNavigate) return notice(this.t("knowledge.finishTaskAction"));
      pageIndex--;
      selectedTask = "";
      detail.clear();
      listSignature = "";
      get("[data-knowledge-tasks]").textContent = this.t("knowledge.loading");
      notice("");
      void refresh().then(() => {
        if (signal.aborted) return;
        get("[data-knowledge-tasks]").scrollTop = 0;
        this.dialog
          .querySelector<HTMLButtonElement>('[data-knowledge-task][aria-pressed="true"]')
          ?.focus({ preventScroll: true });
      });
    };
    get("[data-knowledge-older]").onclick = () => {
      if (pageLoading || !nextCursor) return;
      if (!detail.canNavigate) return notice(this.t("knowledge.finishTaskAction"));
      cursors = [...cursors.slice(0, pageIndex + 1), nextCursor];
      pageIndex++;
      selectedTask = "";
      detail.clear();
      listSignature = "";
      get("[data-knowledge-tasks]").textContent = this.t("knowledge.loading");
      notice("");
      void refresh().then(() => {
        if (signal.aborted) return;
        get("[data-knowledge-tasks]").scrollTop = 0;
        this.dialog
          .querySelector<HTMLButtonElement>('[data-knowledge-task][aria-pressed="true"]')
          ?.focus({ preventScroll: true });
      });
    };
    this.dialog.querySelector<HTMLButtonElement>('[data-knowledge-action="refresh"]')!.onclick = () => {
      polls = 0;
      void refresh().then(() => {
        const task = tasks.find((task) => task.id === selectedTask);
        if (task && !signal.aborted) void detail.select(task, true).catch(report);
      });
    };
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") {
          polls = 0;
          void refresh();
        }
      },
      { signal },
    );
    form.onsubmit = (event) => {
      event.preventDefault();
      if (busy || !available) return;
      const selected = sourcePicker.selection;
      if (!submission.pending && !sourcePicker.ready) return;
      if (!submission.pending && (!selected.ids.length || selected.ids.length > 32))
        return notice(this.t("knowledge.selectionLimit"));
      const input = submission.begin(selected.ids, purpose.value, selected.contentKinds);
      busy = true;
      controls();
      void knowledgeRequest<{ task: KnowledgeTask }>("/tasks", "POST", input, signal)
        .then(({ task }) => {
          submission.acknowledge();
          if (signal.aborted) return;
          sequence++;
          listRead?.abort();
          pageIndex = 0;
          cursors = [undefined];
          nextCursor = null;
          selectedTask = task.id;
          merge(task);
          pageControls();
          notice("");
          schedule();
        })
        .catch((error) => {
          if (!signal.aborted) report(error);
        })
        .finally(() => {
          if (!signal.aborted) {
            busy = false;
            controls();
          }
        });
    };
    notice(this.t(submission.pending ? "knowledge.pending" : "knowledge.loading"));
    try {
      const [options] = await Promise.all([
        knowledgeApi.options(signal),
        preference.load(),
        refresh(),
        sourcePicker.load(),
      ]);
      if (signal.aborted) return;
      available = options.available;
      controls();
      if (!submission.pending) notice(available ? "" : this.t("knowledge.unavailable"));
      schedule();
    } catch (error) {
      if (!signal.aborted) report(error);
    }
  }
}
