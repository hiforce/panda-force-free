import { captureDatabaseFocus, restoreDatabaseFocus } from "./focus.js";
import type {
  DatabaseOverview,
  DatabaseOperation,
  DatabaseMigrationPlan,
  DatabaseConnectionTest,
  DatabaseIssue,
} from "../../shared/database/contracts.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import { getBrowserI18n, setMessageHtml } from "../i18n.js";
import { databaseRequest, DatabaseRequestError } from "./api.js";
import { databaseSettingsHtml, databasePlanHtml, databaseOperationHtml, databaseIssues } from "./view.js";
import { emptyDatabaseForm, readDatabaseForm, fillDatabaseForm, databaseConnectionInput } from "./form.js";
import {
  readDatabaseRecovery,
  rememberDatabaseRecovery,
  clearDatabaseRecovery,
  type DatabaseRecovery,
} from "./recovery.js";
import { databaseIssueMessage } from "./messages.js";

/** A page lifetime owns reads and password memory. A persisted capability owns uncertain submissions across restarts. */
export function createDatabaseSettings(t: Translate) {
  let host: HTMLElement | null = null,
    overview: DatabaseOverview | null = null,
    operation: DatabaseOperation | null = null,
    plan: DatabaseMigrationPlan | null = null,
    form = emptyDatabaseForm(),
    recovery: DatabaseRecovery | null = null,
    closing = new AbortController(),
    epoch = 0,
    busy = false,
    uncertainAction = false,
    poll: ReturnType<typeof setTimeout> | undefined,
    expiry: ReturnType<typeof setTimeout> | undefined,
    dismissed = "",
    scrollPosition = 0,
    noticeId: MessageId | null = null,
    noticeCode: string | null = null,
    noticeIssues: DatabaseIssue[] | null = null;
  const get = <T extends HTMLElement>(q: string) => host?.querySelector<T>(q) ?? null;
  function paintNotice() {
    const target = get("[data-database-notice]");
    if (!target) return;
    if (noticeIssues) setMessageHtml(target, databaseIssues(t, noticeIssues));
    else target.textContent = noticeCode ? databaseIssueMessage(t, noticeCode) : noticeId ? t(noticeId) : "";
  }
  const notice = (id: MessageId | null) => {
    noticeId = id;
    noticeCode = null;
    noticeIssues = null;
    paintNotice();
  };
  const active = () =>
    (!!recovery && !operation) || (!!operation && !["complete", "canceled"].includes(operation.status));
  function controls() {
    if (!host) return;
    get<HTMLFieldSetElement>("[data-database-fields]")?.toggleAttribute("disabled", busy);
    for (const button of host.querySelectorAll<HTMLButtonElement>(
      "[data-database-refresh],[data-database-retry],[data-database-cancel],[data-database-recover],[data-database-edit],[data-database-done]",
    ))
      button.disabled =
        busy ||
        ((button.hasAttribute("data-database-retry") || button.hasAttribute("data-database-cancel")) &&
          (uncertainAction || recovery?.id !== operation?.id));
    const review = get<HTMLButtonElement>("[data-database-review]");
    if (review) review.disabled = busy || !overview?.readiness.ready;
    const start = get<HTMLButtonElement>("[data-database-migrate]");
    if (start) start.disabled = busy || !plan?.ready || plan.expiresAt <= Date.now() || !overview?.readiness.ready;
    const configuration = get("[data-database-configuration]");
    if (configuration) configuration.hidden = active();
    host.setAttribute("aria-busy", String(busy));
  }
  function renderOperation() {
    const target = get("[data-database-operation]");
    if (!target) return;
    const focus = captureDatabaseFocus(target);
    const diagnosticsOpen = target.querySelector<HTMLDetailsElement>(".database-diagnostics")?.open;
    setMessageHtml(
      target,
      operation
        ? databaseOperationHtml(t, operation, recovery?.id === operation.id)
        : recovery
          ? `<section class="database-operation"><h3 tabindex="-1" data-database-operation-title>${t("database.operation")}</h3><p>${t("database.unknown")}</p><button type="button" class="wb-button" data-database-recover>${t("database.checkStatus")}</button></section>`
          : "",
    );
    if (diagnosticsOpen) {
      const details = target.querySelector<HTMLDetailsElement>(".database-diagnostics");
      if (details) details.open = true;
    }
    controls();
    restoreDatabaseFocus(target, focus);
  }
  function renderPlan() {
    const target = get("[data-database-plan]");
    if (!target) return;
    setMessageHtml(target, plan ? databasePlanHtml(t, plan) : "");
    const fields = get<HTMLFormElement>("[data-database-form]");
    if (fields) fields.hidden = !!plan;
    clearTimeout(expiry);
    if (plan)
      expiry = setTimeout(
        () => {
          notice("database.migrationPlanExpired");
          controls();
        },
        Math.max(0, Math.min(2147483647, plan.expiresAt - Date.now())),
      );
    controls();
  }
  function render() {
    if (!host) return;
    form = readDatabaseForm(host, form);
    const focus = captureDatabaseFocus(host),
      scroll = host.closest<HTMLElement>(".settings-content"),
      position = scroll?.scrollTop ?? 0;
    setMessageHtml(host, databaseSettingsHtml(t, overview));
    fillDatabaseForm(host, form);
    renderPlan();
    renderOperation();
    paintNotice();
    if (scroll) scroll.scrollTop = position;
    restoreDatabaseFocus(host, focus);
  }
  function schedule(work: () => Promise<void>, delay = 2000) {
    clearTimeout(poll);
    if (host) poll = setTimeout(() => void work(), delay);
  }
  function error(value: unknown) {
    const code = value instanceof DatabaseRequestError ? value.code : "databaseUnavailable";
    if (code === "administratorRequired" && overview) {
      overview.administrator = false;
      form.password = "";
      render();
    }
    noticeId = null;
    noticeCode = code;
    noticeIssues = null;
    paintNotice();
  }
  async function recover() {
    if (!host || !recovery || busy) return;
    const ticket = epoch,
      ctx = recovery;
    try {
      const result = await databaseRequest<DatabaseOperation>(
        "/operations/" + encodeURIComponent(ctx.id),
        "GET",
        undefined,
        closing.signal,
        ctx.statusToken,
      );
      if (!host || epoch !== ticket) return;
      operation = result;
      uncertainAction = false;
      notice(null);
      renderOperation();
      if (result.status === "running" || result.status === "waiting-restart") schedule(recover);
      else if (result.status === "complete") void refresh(false);
    } catch (value) {
      if (!host || epoch !== ticket || closing.signal.aborted) return;
      if (value instanceof DatabaseRequestError && [401, 403].includes(value.status)) {
        uncertainAction = true;
        error(value);
        controls();
        return;
      }
      notice(
        value instanceof DatabaseRequestError && value.code === "operationNotFound"
          ? "database.noReceipt"
          : "database.unknown",
      );
      if (!(value instanceof DatabaseRequestError && [401, 403].includes(value.status))) schedule(recover, 4000);
    }
  }
  async function refresh(recoverSaved = true) {
    if (!host || busy) return;
    const ticket = epoch;
    try {
      const result = await databaseRequest<DatabaseOverview>("", "GET", undefined, closing.signal);
      if (!host || ticket !== epoch) return;
      overview = result;
      const candidate = result.operation?.id === dismissed ? null : result.operation;
      operation = candidate ?? operation;
      recovery = readDatabaseRecovery();
      if (candidate && !["complete", "canceled", "failed"].includes(candidate.status) && recovery?.id !== candidate.id)
        recovery = null;
      render();
      if (recoverSaved && recovery) await recover();
      else if (operation && ["running", "waiting-restart"].includes(operation.status)) schedule(() => refresh(false));
    } catch (value) {
      if (host && ticket === epoch && !closing.signal.aborted) error(value);
    }
  }
  async function run(id: MessageId, work: () => Promise<void>) {
    if (!host || busy) return;
    busy = true;
    const ticket = epoch;
    notice(id);
    controls();
    try {
      await work();
    } catch (value) {
      if (host && ticket === epoch && !closing.signal.aborted) error(value);
    } finally {
      if (host && ticket === epoch) {
        busy = false;
        controls();
      }
    }
  }
  async function submitConnection(action: string) {
    form = readDatabaseForm(host!, form);
    const input = databaseConnectionInput(form),
      ticket = epoch;
    await run(action === "test" ? "database.testing" : "database.planning", async () => {
      if (action === "test") {
        const result = await databaseRequest<DatabaseConnectionTest>("/test", "POST", input, closing.signal);
        if (ticket !== epoch) return;
        if (result.ok) notice("database.testPassed");
        else {
          notice(null);
          noticeIssues = result.issues.length ? result.issues : [{ code: "connectionFailed" }];
          paintNotice();
        }
      } else {
        const result = await databaseRequest<DatabaseMigrationPlan>("/plan", "POST", input, closing.signal);
        if (ticket !== epoch) return;
        plan = result;
        notice(null);
        renderPlan();
        get<HTMLElement>("#database-plan-title")?.focus({ preventScroll: true });
        get("[data-database-plan]")?.scrollIntoView({ block: "nearest" });
      }
    });
  }
  async function migrate() {
    if (
      !plan?.ready ||
      !overview?.administrator ||
      !overview.readiness.ready ||
      plan.expiresAt <= Date.now() ||
      busy ||
      (recovery && (!operation || !["complete", "canceled"].includes(operation.status)))
    )
      return;
    const accepted = plan,
      ticket = epoch;
    await run("database.starting", async () => {
      try {
        recovery = rememberDatabaseRecovery();
      } catch {
        notice("database.recoveryUnavailable");
        return;
      }
      const ctx = recovery;
      operation = null;
      renderOperation();
      get<HTMLElement>("[data-database-operation-title]")?.focus({ preventScroll: true });
      get("[data-database-operation]")?.scrollIntoView({ block: "nearest" });
      try {
        const result = await databaseRequest<DatabaseOperation>(
          "/migrate",
          "POST",
          { planId: accepted.id, requestId: ctx.id, statusToken: ctx.statusToken },
          closing.signal,
        );
        if (ticket !== epoch) return;
        operation = result;
        plan = null;
        notice(null);
        renderPlan();
        renderOperation();
        get<HTMLElement>("[data-database-operation-title]")?.focus({ preventScroll: true });
        schedule(recover, 1000);
      } catch (value) {
        if (ticket !== epoch) return;
        if (
          value instanceof DatabaseRequestError &&
          value.status >= 400 &&
          value.status < 500 &&
          [
            "migrationPlanExpired",
            "administratorRequired",
            "invalidDatabaseConfiguration",
            "incompleteDatabaseBackend",
            "migrationTargetAlreadyOwned",
            "botDatabaseTargetMismatch",
            "migrationAlreadyRunning",
          ].includes(value.code)
        ) {
          try {
            const fresh = await databaseRequest<DatabaseOverview>("", "GET", undefined, closing.signal);
            if (ticket !== epoch) return;
            overview = fresh;
            if (fresh.operation?.id === ctx.id) {
              operation = fresh.operation;
              renderOperation();
            } else {
              clearDatabaseRecovery();
              recovery = null;
              plan = null;
              operation = fresh.operation ?? null;
              render();
              error(value);
            }
            return;
          } catch {}
        }
        notice("database.unknown");
        schedule(recover, 0);
      }
    });
  }
  async function operationAction(action: "retry" | "cancel") {
    if (
      busy ||
      uncertainAction ||
      !operation ||
      !recovery ||
      operation.id !== recovery.id ||
      !(action === "retry" ? operation.canRetry : operation.canCancel)
    )
      return;
    const ctx = recovery,
      ticket = epoch;
    uncertainAction = true;
    await run("database.updating", async () => {
      try {
        const result = await databaseRequest<DatabaseOperation>(
          "/operations/" + encodeURIComponent(ctx.id) + "/" + action,
          "POST",
          {},
          closing.signal,
          ctx.statusToken,
        );
        if (ticket !== epoch) return;
        operation = result;
        uncertainAction = false;
        notice(null);
        renderOperation();
        if (result.status === "running" || result.status === "waiting-restart") schedule(recover, 1000);
      } catch (value) {
        if (ticket !== epoch) return;
        notice("database.unknown");
        schedule(recover, 0);
      }
    });
  }
  function hide() {
    epoch++;
    clearTimeout(poll);
    clearTimeout(expiry);
    closing.abort();
    if (host) {
      scrollPosition = host.closest<HTMLElement>(".settings-content")?.scrollTop ?? 0;
      form = readDatabaseForm(host, form);
      const password = get<HTMLInputElement>('[data-database-field="password"]');
      if (password) password.value = "";
    }
    form.password = "";
    host = null;
    busy = false;
  }
  function show(element: HTMLElement) {
    if (host === element) return;
    hide();
    closing = new AbortController();
    host = element;
    recovery = readDatabaseRecovery();
    uncertainAction = !!recovery;
    render();
    requestAnimationFrame(() => {
      if (host === element) {
        const scroll = element.closest<HTMLElement>(".settings-content");
        if (scroll) scroll.scrollTop = scrollPosition;
      }
    });
    element.addEventListener(
      "submit",
      (event) => {
        if (!(event.target instanceof HTMLFormElement) || !event.target.hasAttribute("data-database-form")) return;
        event.preventDefault();
        const button = (event as SubmitEvent).submitter as HTMLButtonElement | null;
        if (!busy) void submitConnection(button?.value === "plan" ? "plan" : "test");
      },
      { signal: closing.signal },
    );
    element.addEventListener(
      "input",
      () => {
        form = readDatabaseForm(element, form);
        if (plan) {
          plan = null;
          renderPlan();
        }
      },
      { signal: closing.signal },
    );
    element.addEventListener(
      "click",
      (event) => {
        const target = (event.target as Element).closest<HTMLButtonElement>("button");
        if (!target || busy) return;
        if (target.hasAttribute("data-database-refresh")) void refresh();
        else if (target.hasAttribute("data-database-recover")) void (recovery ? recover() : refresh());
        else if (target.hasAttribute("data-database-migrate")) void migrate();
        else if (target.hasAttribute("data-database-retry")) void operationAction("retry");
        else if (target.hasAttribute("data-database-cancel")) void operationAction("cancel");
        else if (target.hasAttribute("data-database-edit")) {
          plan = null;
          renderPlan();
          get<HTMLInputElement>('[data-database-field="hostname"]')?.focus();
        } else if (target.hasAttribute("data-database-done")) {
          dismissed = operation?.id ?? "";
          operation = null;
          recovery = null;
          clearDatabaseRecovery();
          renderOperation();
          void refresh(false);
        }
      },
      { signal: closing.signal },
    );
    void refresh();
  }
  getBrowserI18n().subscribe(() => {
    if (host) render();
  });
  return { show, hide };
}
