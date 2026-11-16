import type { DatabaseOperation, DatabaseOverview } from "../../shared/database/contracts.js";
import { getBrowserI18n, setMessageHtml } from "../i18n.js";
import { request } from "../http-client.js";
import { escapeHtml as e } from "../../shared/html.js";
import { databaseRequest, DatabaseRequestError } from "./api.js";
import { findDatabaseRecovery } from "./recovery.js";
import { databaseOperationHtml } from "./view.js";
import type { MessageId } from "../../shared/i18n/messages.js";
interface MaintenanceStatus {
  operationId: string;
  status: "running" | "failed" | "complete";
}
/** A small public shell reveals private progress only after the browser supplies its operation capability. */
export async function initializeDatabaseMaintenance(root: HTMLElement) {
  const i18n = getBrowserI18n();
  await (i18n as typeof i18n & { ready?: Promise<unknown> }).ready;
  const t = i18n.t;
  let operation: DatabaseOperation | null = null,
    status: MaintenanceStatus | null = null,
    notice: MessageId | null = null,
    busy = false,
    stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  function render() {
    document.title = t("database.maintenanceTitle");
    const focused = root.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)?.dataset.databaseRecover !== undefined
      : false;
    setMessageHtml(
      root,
      `<main class="database-maintenance-shell"><div class="database-settings"><header><h1>${e(t("database.maintenanceTitle"))}</h1><p>${e(t("database.maintenanceHint"))}</p></header><p role="status" aria-live="polite" data-maintenance-notice>${e(notice ? t(notice) : "")}</p>${operation ? databaseOperationHtml(t, operation, true, "database.reconnecting") : `<p>${e(t(status?.status === "failed" ? "database.maintenanceFailed" : "database.maintenancePrivate"))}</p><div class="database-actions"><button type="button" class="wb-button" data-database-recover>${e(t("database.checkStatus"))}</button></div>`}</div></main>`,
    );
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
    if (focused) root.querySelector<HTMLButtonElement>("[data-database-recover]")?.focus({ preventScroll: true });
  }
  function schedule() {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => void poll(), 2000);
  }
  async function normalReady() {
    try {
      const response = await request("/api/system/database", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      });
      if (response.status === 401 || response.status === 403) return true;
      if (!response.ok) return false;
      const result = (await response.json()) as DatabaseOverview;
      return result.schema === 1 && typeof result.administrator === "boolean";
    } catch {
      return false;
    }
  }
  async function poll() {
    if (stopped || busy) return;
    try {
      status = await databaseRequest<MaintenanceStatus>("/maintenance", "GET", undefined, controller.signal);
      const ctx = findDatabaseRecovery(status.operationId);
      if (ctx) {
        try {
          operation = await databaseRequest<DatabaseOperation>(
            "/operations/" + encodeURIComponent(ctx.id),
            "GET",
            undefined,
            controller.signal,
            ctx.statusToken,
          );
        } catch (error) {
          if (
            status.status !== "complete" ||
            !(error instanceof DatabaseRequestError) ||
            ![401, 403].includes(error.status)
          )
            throw error;
          operation = null;
        }
        notice = null;
      } else {
        operation = null;
        notice = null;
      }
      if (status.status === "complete" || operation?.status === "complete") {
        notice = operation ? null : "database.reconnecting";
        render();
        if (await normalReady()) {
          stopped = true;
          location.replace("/settings/storage");
          return;
        }
      } else render();
    } catch (value) {
      if (value instanceof DatabaseRequestError && [401, 403].includes(value.status)) operation = null;
      notice = operation ? "database.unknown" : "database.reconnecting";
      render();
    } finally {
      schedule();
    }
  }
  async function action(kind: "retry" | "cancel") {
    if (!operation || busy || !(kind === "retry" ? operation.canRetry : operation.canCancel)) return;
    const ctx = findDatabaseRecovery(operation.id);
    if (!ctx) return;
    busy = true;
    notice = "database.updating";
    render();
    try {
      operation = await databaseRequest<DatabaseOperation>(
        "/operations/" + encodeURIComponent(ctx.id) + "/" + kind,
        "POST",
        {},
        controller.signal,
        ctx.statusToken,
      );
      notice = null;
    } catch {
      notice = "database.unknown";
    } finally {
      busy = false;
      render();
      schedule();
    }
  }
  root.addEventListener(
    "click",
    (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button");
      if (!button || busy) return;
      if (button.hasAttribute("data-database-retry")) void action("retry");
      else if (button.hasAttribute("data-database-cancel")) void action("cancel");
      else if (button.hasAttribute("data-database-recover")) void poll();
      else if (button.hasAttribute("data-database-done")) void poll();
    },
    { signal: controller.signal },
  );
  i18n.subscribe(() => {
    if (!stopped) render();
  });
  addEventListener(
    "pagehide",
    () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    },
    { once: true },
  );
  render();
  await poll();
}
const host = document.getElementById("database-maintenance");
if (host) void initializeDatabaseMaintenance(host);
