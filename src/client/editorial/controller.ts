import { createRuntimeModelField } from "../harness/model-field.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentRecord } from "../../shared/documents/contracts.js";
import type { EditorialDetail, EditorialReceipt, EditorialSummary } from "../../shared/editorial/contracts.js";
import { editorialSummary } from "../../shared/editorial/summary.js";
import { setMessageHtml, localizeText, errorText } from "../i18n.js";

import { editorialApiFor, EditorialApiError, type EditorialApi } from "./api.js";
import { editorialFrame, suggestionView, editorialHistory } from "./views.js";
import { escapeHtml as e } from "../../shared/html.js";
import { createEditorialTasks, type EditorialTasks } from "./tasks.js";
import { modelControls, taskView, taskHistory } from "./task-views.js";

interface ReviewSession {
  api: EditorialApi;
  record: DocumentRecord;
  detail: EditorialDetail | null;
  history: EditorialSummary[];
  historyCursor: string | null;
  historyReads: number;
  busy: boolean;
  applying: boolean;
  prepareId: string | null;
  pendingSelection: string[] | null;
  resolve(receipt: EditorialReceipt | null): void;
  previous: Element | null;
  tasks: EditorialTasks;
  taskMarkup: string;
  taskHistoryMarkup: string;
  profilesMarkup: string;
  runtimeFields?: ReturnType<typeof createRuntimeModelField>;
}
/** Each opening owns its requests and result. A hidden in-flight commit still returns its authorized receipt. */
export function createEditorialWorkspace(t: Translate) {
  const dialog = document.createElement("dialog");
  dialog.id = "editorialDialog";
  dialog.className = "publishing-dialog editorial-dialog";
  dialog.setAttribute("aria-labelledby", "editorialTitle");
  document.body.append(dialog);
  let session: ReviewSession | null = null;
  const get = <T extends Element>(selector: string) => dialog.querySelector<T>(selector)!;
  function close(force = false, receipt: EditorialReceipt | null = null) {
    const current = session;
    session = null;
    dialog.close();
    if (!current) return;
    current.tasks.close();
    current.runtimeFields?.close();
    if (force || !current.applying || receipt) current.resolve(receipt);
    if (current.previous instanceof HTMLElement && current.previous.isConnected)
      current.previous.focus({ preventScroll: true });
  }
  function status(value: string, error = false) {
    const target = get<HTMLElement>("#editorialStatus");
    target.textContent = value;
    target.dataset.error = String(error);
  }
  function renderTasks(current: ReviewSession) {
    if (session !== current) return;
    const { state } = current.tasks;
    if (state.ready) {
      const options =
        (state.runtimeSelection ? `<option value="__harness_runtime__">${e(t("harness.title"))}</option>` : "") +
        state.profiles
          .map((profile) => `<option value="${e(profile.id)}">${e(profile.id)} · ${e(profile.model)}</option>`)
          .join("");
      if (options !== current.profilesMarkup) {
        const select = get<HTMLSelectElement>("#editorialProcessor"),
          selected = select.value;
        setMessageHtml(select, options);
        if (
          (state.runtimeSelection && selected === "__harness_runtime__") ||
          state.profiles.some((profile) => profile.id === selected)
        )
          select.value = selected;
        current.profilesMarkup = options;
      }
      localizeText(
        get("#editorialProcessorHint"),
        state.runtimeSelection && get<HTMLSelectElement>("#editorialProcessor").value === "__harness_runtime__"
          ? "harness.selectionHint"
          : state.configurationInvalid
            ? "editorial.invalidProcessorConfiguration"
            : state.profiles.length
              ? "editorial.providerScope"
              : "editorial.noProcessors",
        undefined,
        t,
      );
    } else
      localizeText(
        get("#editorialProcessorHint"),
        state.loadError ? "editorial.processorsUnavailable" : "editorial.loadingProcessors",
        undefined,
        t,
      );
    const runtimeHost = get<HTMLElement>("[data-editorial-runtime]");
    if (state.ready && state.runtimeSelection && !current.runtimeFields) {
      const fields = createRuntimeModelField(t, "editorial", () => {
        if (session === current) taskControls(current);
      });
      current.runtimeFields = fields;
      setMessageHtml(runtimeHost, fields.html());
      fields.mount(runtimeHost);
    }
    const card = taskView(t, current.tasks),
      history = taskHistory(t, current.tasks);
    if (!current.taskMarkup && state.current && ["queued", "running"].includes(state.current.state))
      get<HTMLDetailsElement>(".editorial-model-controls").open = true;
    if (card !== current.taskMarkup) {
      setMessageHtml(get("#editorialTask"), card);
      current.taskMarkup = card;
    }
    if (history !== current.taskHistoryMarkup) {
      setMessageHtml(get("#editorialTaskHistory"), history);
      current.taskHistoryMarkup = history;
    }
    controls(current);
  }
  function taskControls(current: ReviewSession) {
    const { state } = current.tasks,
      blocked = current.busy || !!current.pendingSelection || state.pending;
    get<HTMLButtonElement>('[data-editorial-action="model-submit"]').disabled =
      blocked ||
      !state.ready ||
      (!state.runtimeSelection && !state.profiles.length) ||
      (get<HTMLSelectElement>("#editorialProcessor").value === "__harness_runtime__" &&
        !current.runtimeFields?.ready()) ||
      (!!state.current && ["queued", "running"].includes(state.current.state));
    for (const id of ["#editorialMode", "#editorialProcessor", "#editorialTaskHistory"])
      get<HTMLSelectElement>(id).disabled =
        blocked ||
        !state.ready ||
        current.tasks.uncertainSubmission ||
        (id === "#editorialProcessor" && !state.runtimeSelection && !state.profiles.length);
    const runtimeSelected = get<HTMLSelectElement>("#editorialProcessor").value === "__harness_runtime__";
    get<HTMLElement>("[data-editorial-runtime]").hidden = !runtimeSelected;
    current.runtimeFields?.setLocked(
      blocked ||
        current.tasks.uncertainSubmission ||
        (!!state.current && ["queued", "running"].includes(state.current.state)),
    );
    for (const action of ["model-cancel", "model-retry", "model-view"]) {
      const button = dialog.querySelector<HTMLButtonElement>(`[data-editorial-action="${action}"]`);
      if (button) button.disabled = blocked || (action === "model-view" && !state.current?.proposalId);
    }
    localizeText(
      get('[data-editorial-action="model-submit"]'),
      current.tasks.uncertainSubmission ? "editorial.retrySubmission" : "editorial.submitJob",
      undefined,
      t,
    );
  }
  function controls(current: ReviewSession) {
    if (session !== current) return;
    for (const input of dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
      "input,button,select",
    )) {
      if (input.dataset.editorialAction === "close") continue;
      input.disabled =
        current.busy ||
        (!!current.pendingSelection && input.dataset.editorialAction !== "apply") ||
        (!!current.detail?.receipt && input.matches("input")) ||
        (!!current.detail?.stale && input.matches("input"));
    }
    const selected = dialog.querySelectorAll("[data-editorial-edit]:checked").length;
    get<HTMLButtonElement>('[data-editorial-action="apply"]').disabled =
      current.busy ||
      !current.detail ||
      current.detail.stale ||
      !!current.detail.receipt ||
      (!selected && !current.pendingSelection);
    localizeText(
      get('[data-editorial-action="apply"]'),
      current.pendingSelection && !current.busy ? "editorial.retryApply" : "editorial.apply",
      undefined,
      t,
    );
    taskControls(current);
    get<HTMLButtonElement>('[data-editorial-action="more-history"]').hidden = !current.historyCursor;
    localizeText(
      get("#editorialSelected"),
      "editorial.selectedCount",
      { count: current.pendingSelection?.length ?? selected },
      t,
    );
  }
  function show(current: ReviewSession, detail: EditorialDetail) {
    current.detail = detail;
    current.pendingSelection = detail.receipt ? null : (detail.pending?.selected ?? current.pendingSelection);
    current.history = [
      { ...editorialSummary(detail.proposal), applied: !!detail.receipt, stale: detail.stale },
      ...current.history.filter((item) => item.id !== detail.proposal.id),
    ];
    setMessageHtml(get("#editorialSuggestions"), suggestionView(t, detail));
    setMessageHtml(get("#editorialHistory"), editorialHistory(t, current.history, detail.proposal.id));
    controls(current);
    if (detail.proposal.producer.kind === "model" && matchMedia("(max-width: 700px)").matches) {
      get<HTMLDetailsElement>(".editorial-model-controls").open = false;
      requestAnimationFrame(() => {
        if (session !== current || current.detail !== detail) return;
        const layout = get<HTMLElement>(".publishing-layout"),
          main = get<HTMLElement>(".publishing-main");
        layout.scrollTo({
          top: main.getBoundingClientRect().top - layout.getBoundingClientRect().top + layout.scrollTop,
          behavior: "instant",
        });
      });
    }
  }
  async function prepare(current: ReviewSession) {
    current.prepareId ??= crypto.randomUUID();
    const detail = await current.api.prepare(current.prepareId, current.record.id, current.record.revisionId);
    if (session !== current) return;
    current.prepareId = null;
    show(current, detail);
    await loadHistory(current);
  }
  async function loadHistory(current: ReviewSession) {
    const read = ++current.historyReads;
    const page = await current.api.history(current.record.id);
    if (session !== current || read !== current.historyReads) return;
    current.history = current.detail
      ? [
          {
            ...editorialSummary(current.detail.proposal),
            applied: !!current.detail.receipt,
            stale: current.detail.stale,
          },
          ...page.reviews.filter((item) => item.id !== current.detail!.proposal.id),
        ]
      : page.reviews;
    current.historyCursor = page.nextCursor;
    setMessageHtml(get("#editorialHistory"), editorialHistory(t, current.history, current.detail?.proposal.id || ""));
    controls(current);
  }
  async function run(action: string) {
    const current = session;
    if (!current || current.busy) return;
    current.busy = true;
    controls(current);
    status(t(action === "more-history" ? "editorial.loadingHistory" : "editorial.working"));
    try {
      if (action === "prepare") await prepare(current);
      else if (action === "more-history" && current.historyCursor) {
        const page = await current.api.history(current.record.id, current.historyCursor);
        if (session !== current) return;
        const known = new Set(current.history.map((review) => review.id));
        current.history.push(...page.reviews.filter((review) => !known.has(review.id)));
        current.historyCursor = page.nextCursor;
        setMessageHtml(
          get("#editorialHistory"),
          editorialHistory(t, current.history, current.detail?.proposal.id || ""),
        );
      } else if (action === "history") {
        const id = get<HTMLSelectElement>("#editorialHistory").value;
        if (id) {
          const detail = await current.api.detail(id);
          if (session === current) show(current, detail);
        }
      } else if (action === "apply" && current.detail) {
        current.pendingSelection ??= [
          ...dialog.querySelectorAll<HTMLInputElement>("[data-editorial-edit]:checked"),
        ].map((input) => input.dataset.editorialEdit!);
        if (!current.pendingSelection.length) return;
        current.applying = true;
        const { receipt } = await current.api.accept(
          current.detail.proposal.id,
          current.detail.digest,
          current.pendingSelection,
        );
        current.pendingSelection = null;
        current.resolve(receipt);
        if (session === current) close(false, receipt);
      } else if (action === "model-submit")
        await current.tasks.submit(
          get<HTMLSelectElement>("#editorialMode").value as "proofread" | "rewrite",
          get<HTMLSelectElement>("#editorialProcessor").value,
          get<HTMLSelectElement>("#editorialProcessor").value === "__harness_runtime__"
            ? current.runtimeFields?.read()
            : undefined,
        );
      else if (action === "model-reload") await current.tasks.load();
      else if (action === "model-cancel") await current.tasks.cancel();
      else if (action === "model-retry") await current.tasks.retry();
      else if (action === "model-view" && current.tasks.state.current?.proposalId) {
        const detail = await current.api.detail(current.tasks.state.current.proposalId);
        if (session === current) show(current, detail);
      }
      if (session === current) status("");
    } catch (error) {
      if (
        error instanceof EditorialApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        current.pendingSelection &&
        current.detail
      ) {
        try {
          const detail = await current.api.detail(current.detail.proposal.id);
          if (session === current) {
            current.pendingSelection = detail.pending?.selected ?? null;
            show(current, detail);
          }
        } catch {
          /* Retain the confirmed selection until its durable state can be read. */
        }
      }
      if (session === current)
        status(
          current.pendingSelection && !(error instanceof EditorialApiError && error.status >= 400 && error.status < 500)
            ? t("editorial.uncertainApply")
            : errorText(error instanceof EditorialApiError ? error.payload : null, t, "editorial.unavailable"),
          true,
        );
      else current.resolve(null);
    } finally {
      current.busy = false;
      current.applying = false;
      controls(current);
    }
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-editorial-action]") : null;
    if (!button || button.disabled) return;
    if (button.dataset.editorialAction === "close") close();
    else void run(button.dataset.editorialAction!);
  });
  dialog.addEventListener("change", (event) => {
    if ((event.target as Element).id === "editorialHistory") void run("history");
    else if ((event.target as Element).id === "editorialTaskHistory" && session)
      session.tasks.select((event.target as HTMLSelectElement).value);
    else if (session) controls(session);
  });
  return {
    close: () => close(true),
    open(record: DocumentRecord, options?: { projectId?: string }): Promise<EditorialReceipt | null> {
      close(true);
      return new Promise((resolve) => {
        const api = editorialApiFor(options?.projectId);
        const current: ReviewSession = {
          api,
          record,
          detail: null,
          history: [],
          historyCursor: null,
          historyReads: 0,
          busy: false,
          applying: false,
          prepareId: null,
          pendingSelection: null,
          resolve,
          previous: document.activeElement,
          tasks: createEditorialTasks(
            record,
            () => renderTasks(current),
            (error) => {
              if (session === current)
                status(
                  errorText(error instanceof EditorialApiError ? error.payload : null, t, "editorial.unavailable"),
                  true,
                );
            },
            api,
          ),
          taskMarkup: "",
          taskHistoryMarkup: "",
          profilesMarkup: "",
        };
        session = current;
        setMessageHtml(dialog, editorialFrame(t, record.title));
        setMessageHtml(get("#editorialTaskWorkspace"), modelControls(t));
        get<HTMLSelectElement>("#editorialProcessor").addEventListener("change", () => taskControls(current));
        dialog.showModal();
        void loadHistory(current).catch((error) => {
          if (session === current)
            status(
              errorText(error instanceof EditorialApiError ? error.payload : null, t, "editorial.unavailable"),
              true,
            );
        });
        void run("prepare");
        void current.tasks.load().catch((error) => {
          if (session === current)
            status(
              errorText(error instanceof EditorialApiError ? error.payload : null, t, "editorial.unavailable"),
              true,
            );
        });
      });
    },
  };
}
