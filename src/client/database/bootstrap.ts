import { readDatabaseRecovery } from "./recovery.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { DatabaseOverview } from "../../shared/database/contracts.js";
import { databaseRequest } from "./api.js";
import { localizeText } from "../i18n.js";
/** The server owns installation choice state. Browser visits never infer whether setup is required. */
export async function initializeDatabaseSetup(t: Translate) {
  let overview: DatabaseOverview;
  try {
    overview = await databaseRequest<DatabaseOverview>();
  } catch {
    return;
  }
  if (
    !overview.administrator ||
    !overview.initialChoiceRequired ||
    readDatabaseRecovery() ||
    (overview.operation && !["complete", "canceled"].includes(overview.operation.status)) ||
    document.querySelector("[data-database-setup]")
  )
    return;
  const dialog = document.createElement("dialog");
  dialog.className = "workbench-dialog database-setup";
  dialog.dataset.databaseSetup = "";
  dialog.setAttribute("aria-labelledby", "database-setup-title");
  dialog.setAttribute("aria-describedby", "database-setup-hint");
  const heading = document.createElement("h2"),
    description = document.createElement("p"),
    choice = document.createElement("div"),
    recommended = document.createElement("strong"),
    detail = document.createElement("p"),
    notice = document.createElement("p"),
    actions = document.createElement("div"),
    sqlite = document.createElement("button"),
    mysql = document.createElement("button");
  heading.id = "database-setup-title";
  description.id = "database-setup-hint";
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  actions.className = "database-actions";
  choice.className = "database-default-choice";
  sqlite.type = mysql.type = "button";
  sqlite.className = "wb-button primary";
  mysql.className = "wb-button";
  sqlite.dataset.databaseSqlite = "";
  mysql.dataset.databaseConfigure = "";
  localizeText(heading, "database.setupTitle", undefined, t);
  localizeText(description, "database.setupHint", undefined, t);
  localizeText(recommended, "database.recommended", undefined, t);
  localizeText(detail, "database.sqliteHint", undefined, t);
  localizeText(sqlite, "database.useSqlite", undefined, t);
  localizeText(mysql, "database.configure", undefined, t);
  const name = document.createElement("h3");
  name.textContent = "SQLite";
  choice.append(name, recommended, detail);
  actions.append(sqlite, mysql);
  dialog.append(heading, description, choice, notice, actions);
  let busy = false;
  const close = () => {
    if (busy) return;
    dialog.close();
    dialog.remove();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  sqlite.onclick = async () => {
    if (busy) return;
    busy = true;
    sqlite.disabled = mysql.disabled = true;
    localizeText(notice, "database.choosing", undefined, t);
    try {
      await databaseRequest("/selection", "POST", { driver: "sqlite" });
      busy = false;
      close();
    } catch {
      try {
        const current = await databaseRequest<DatabaseOverview>();
        if (!current.initialChoiceRequired) {
          busy = false;
          close();
          return;
        }
      } catch {}
      localizeText(notice, "database.databaseUnavailable", undefined, t);
    } finally {
      busy = false;
      sqlite.disabled = mysql.disabled = false;
    }
  };
  mysql.onclick = () => {
    close();
    if (location.pathname !== "/settings/storage")
      history.pushState(
        { pandaForceSettings: true, codexSettingsReturnPath: location.pathname + location.search + location.hash },
        "",
        "/settings/storage",
      );
    dispatchEvent(new PopStateEvent("popstate"));
    const present = document.querySelector<HTMLInputElement>('[data-database-field="hostname"]');
    if (present) {
      present.focus();
      return;
    }
    const observer = new MutationObserver(() => {
        const field = document.querySelector<HTMLInputElement>('[data-database-field="hostname"]');
        if (field) {
          field.focus();
          observer.disconnect();
          clearTimeout(timer);
        }
      }),
      timer = setTimeout(() => observer.disconnect(), 15000);
    observer.observe(document.body, { subtree: true, childList: true });
  };
  document.body.append(dialog);
  dialog.showModal();
  sqlite.focus();
}
