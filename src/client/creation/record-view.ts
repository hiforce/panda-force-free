import type { CreationTaskView } from "../../shared/creation/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";

/** One title and one metadata line keep recent work readable without repeating the brief. */
export function creationRecordTitle(task: CreationTaskView) {
  if (task.document?.title) return task.document.title;
  if (task.artifact?.title) return task.artifact.title;
  const line = task.prompt
    .trim()
    .split(/[\r\n。！？!?]/, 1)[0]!
    .replace(/\s+/g, " ");
  return line.length > 52 ? line.slice(0, 52) + "…" : line;
}
export function creationRecordView(
  task: CreationTaskView,
  href: string,
  scope: string,
  destination: string,
  state: string,
  locale: string,
  t: Translate,
) {
  const title = creationRecordTitle(task),
    active = !task.failure && ["queued", "running", "committing"].includes(task.state);
  const action = t(task.artifact ? "creation.continueEditing" : "creation.viewProgress");
  return `<a class="creation-record" href="${e(href)}" data-activity-task="${e(task.id)}" data-scope="${e(scope)}" data-state="${task.failure ? "failed" : task.state}" title="${e(destination + " · " + action)}"><span class="creation-record-icon">${codexIcon(task.artifact ? "file" : "pencil")}</span><span class="creation-record-copy"><strong title="${e(title)}">${e(title)}</strong><span class="creation-record-footer"><span class="creation-record-state"><i></i>${e(state)}</span><time datetime="${new Date(active ? task.createdAt : task.updatedAt).toISOString()}">${e(new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(active ? task.createdAt : task.updatedAt))}</time></span></span>${codexIcon("chevronRight")}</a>`;
}
