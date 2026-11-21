import type { CreationTaskDetail } from "../../shared/creation/contracts.js";
import { creationDocumentArtifact } from "../../shared/creation/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { codexIcon } from "../codex-icons.js";
import { creativeAssetsApi } from "../creative/assets-api.js";
import { messageHtml, setMessageHtml } from "../i18n.js";
import type { CreationWorkspaceBridge } from "./session-port.js";
import type { CreationSessionState } from "./session-state.js";

interface SectionPorts {
  t: Translate;
  records(): HTMLElement;
  savedDocument(): CreationTaskDetail | undefined;
  openGoal: CreationWorkspaceBridge["openGoal"];
}
export class CreationSessionSections {
  readonly root = document.createElement("div");
  readonly versions = document.createElement("section");
  readonly selectedDocument = document.createElement("section");
  readonly brief = document.createElement("section");
  private signature = "";
  constructor(
    private readonly state: CreationSessionState,
    private readonly port: SectionPorts,
  ) {}
  clear() {
    this.signature = "";
  }
  render(host: HTMLElement) {
    if (this.root.parentNode !== host) host.replaceChildren(this.root);
    if (this.state.route?.id) {
      const records = this.port.records();
      if (records.parentNode !== this.root) this.root.prepend(records);
    }
    if (this.selectedDocument.parentNode !== this.root)
      this.root.append(this.selectedDocument, this.brief, this.versions);
    const saved = this.port.savedDocument(),
      selected =
        this.state.task?.document ||
        (saved?.artifact?.kind === "document"
          ? {
              ...saved.artifact,
              title: saved.artifact.title || saved.prompt.slice(0, 100),
              revision: saved.artifact.revision || 1,
            }
          : undefined);
    const signature = JSON.stringify([
      selected,
      saved?.artifact,
      this.state.task?.documentStatus,
      creationDocumentArtifact(saved?.artifact)?.file,
      [...this.state.previous.keys()],
      this.state.task?.goal,
      document.documentElement.lang,
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.selectedDocument.hidden = !selected && !saved?.artifact;
      this.versions.hidden = !saved?.artifact;
      this.brief.hidden = !this.state.task;
      if (this.state.task) {
        setMessageHtml(
          this.brief,
          `<div class="session-section-heading"><h3>${messageHtml("creation.currentBrief", {}, this.port.t)}</h3></div><details><summary>${e(this.state.task.prompt.slice(0, 100))}${this.state.task.prompt.length > 100 ? "…" : ""}</summary><p class="creation-session-brief">${e(this.state.task.prompt)}</p></details><div class="creation-brief-actions"><button type="button" class="wb-button" data-creation-supplement>${messageHtml("creation.followUp", {}, this.port.t)}</button>${!this.state.task.goal ? `<button type="button" class="wb-button" data-creation-goal>${messageHtml("creation.createGoal", {}, this.port.t)}</button>` : ""}</div>`,
        );
        this.brief.querySelector<HTMLButtonElement>("button")!.onclick = () =>
          document.querySelector<HTMLTextAreaElement>("#prompt")!.focus();
        this.brief.querySelector<HTMLButtonElement>("[data-creation-goal]")?.addEventListener("click", () => {
          this.port.openGoal({
            threadId: this.state.route?.key || "",
            goalId: "draft",
            objective: this.state.task!.prompt.slice(0, 16000),
            status: "draft",
            detail: this.port.t("creation.goalScope"),
          });
        });
      }
      if (saved?.artifact && saved.artifact.kind !== "document") {
        const asset = saved.artifact;
        setMessageHtml(
          this.selectedDocument,
          `<div class="session-section-heading"><h3>${messageHtml("creative.saved", {}, this.port.t)}</h3></div><p data-i18n-ignore>${e(asset.title)}</p><p class="session-caption" data-i18n-ignore>${e(asset.source.name)}</p><a class="wb-button" href="${e(creativeAssetsApi.content(asset.projectId, asset.assetId, asset.version))}" download>${messageHtml("creative.assetDownload", {}, this.port.t)}</a>`,
        );
      }
      if (selected) {
        const projectLabel =
            this.state.task?.document?.projectId === "personal"
              ? this.port.t("creation.personalDestination")
              : this.state.task?.document?.projectName,
          file = creationDocumentArtifact(saved?.artifact)?.file,
          locationOpen = this.selectedDocument.querySelector<HTMLDetailsElement>(".creation-file-location")?.open;
        setMessageHtml(
          this.selectedDocument,
          `<div class="session-section-heading"><h3>${messageHtml("creation.selectedDocument", {}, this.port.t)}</h3></div><p>${e(selected.title)}</p><p class="session-caption">${messageHtml(this.state.task?.artifact ? "creation.savedRevision" : "creation.basedOnRevision", { version: selected.revision }, this.port.t)}</p>${projectLabel ? `<p class="session-caption" data-creation-document-project>${messageHtml("creation.documentProject", { project: projectLabel }, this.port.t)}</p>` : ""}${this.state.task?.documentStatus === "unavailable" ? `<p class="session-caption" role="status">${messageHtml("creation.documentUnavailable", {}, this.port.t)}</p>` : ""}${file ? `<details class="creation-file-location"${locationOpen ? " open" : ""}><summary>${codexIcon("file")}<span class="creation-file-copy"><span>${messageHtml("creation.savedFile", {}, this.port.t)}</span><strong title="${e(file.path.split("/").at(-1) || "")}">${e(file.path.split("/").at(-1) || "")}</strong></span>${codexIcon("chevronDown")}</summary><p class="session-caption">${e(file.path)}</p></details>` : ""}`,
        );
      }
      setMessageHtml(
        this.versions,
        `<div class="session-section-heading"><h3>${messageHtml("creation.outputVersions", {}, this.port.t)}</h3></div>${[
          ...this.state.previous.values(),
        ]
          .filter(({ task }) => task.artifact)
          .map(
            ({ task }) =>
              `<a class="creation-output-version" data-creation-round="${e(task.id)}" href="/creation/${encodeURIComponent(task.id)}?creationScope=${this.state.route?.scope}">${codexIcon("file")}<span><strong>${task.artifact?.kind === "document" ? messageHtml("creation.savedRevision", { version: task.artifact.revision || 1 }, this.port.t) : messageHtml("creative.saved", {}, this.port.t)}</strong><time>${e(new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "short", timeStyle: "short" }).format(task.createdAt))}</time></span></a>`,
          )
          .join("")}`,
      );
    }
  }
}
