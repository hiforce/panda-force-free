import { localizeText, messageAttributes, messageHtml, setMessageHtml } from "./i18n.js";

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

export function createProjectDialogs({ catalog, t, onSaved, onAssigned }) {
  const dialog = document.createElement("dialog");
  dialog.id = "projectDialog";
  dialog.className = "workbench-dialog project-dialog";
  document.body.append(dialog);
  let returnFocus,
    generation = 0;
  function open(title, body) {
    generation++;
    returnFocus = document.activeElement;
    setMessageHtml(
      dialog,
      `<header><h2>${messageHtml(title, undefined, t)}</h2><button type="button" class="wb-button" data-project-close>${messageHtml("common.close", undefined, t)}</button></header>${body}<p class="project-error" role="alert" hidden></p>`,
    );
    dialog.querySelector("[data-project-close]").onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
  }
  function error(reason) {
    const el = dialog.querySelector(".project-error");
    if (el) {
      el.hidden = false;
      localizeText(el, reason.messageId || reason.message || String(reason), reason.messageArgs, t);
    }
  }
  dialog.addEventListener("close", () => {
    generation++;
    if (returnFocus?.isConnected) returnFocus.focus();
  });
  async function edit(project = null) {
    if (!catalog.ready) await catalog.load();
    const revision = catalog.revision;
    open(
      project ? "common.editProject" : "common.createProject",
      `<form id="projectForm" class="project-form">
      <label for="projectNameInput">${messageHtml("projects.projectName", undefined, t)}</label><input id="projectNameInput" name="name" required maxlength="100" autocomplete="off" value="${escape(project?.name || "")}">
      <label for="projectCodeInput">${messageHtml("projects.projectCode", undefined, t)}</label><input id="projectCodeInput" name="code" required minlength="2" maxlength="64" autocomplete="off" spellcheck="false" value="${escape(project?.code || "")}"><p class="wb-help">${messageHtml("projects.uniqueCode264CharactersLettersNumbersHyphensOrUnderscores", undefined, t)}</p>
      <label for="projectDescriptionInput">${messageHtml("projects.descriptionOptional", undefined, t)}</label><textarea id="projectDescriptionInput" name="description" maxlength="2000" rows="4">${escape(project?.description || "")}</textarea>
      <footer><button type="submit" class="wb-button primary">${messageHtml(project ? "common.saveProject" : "common.createProject", undefined, t)}</button></footer></form>`,
    );
    dialog.querySelector("input").focus();
    dialog.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.currentTarget,
        submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const fields = Object.fromEntries(new FormData(form));
        const saved = await catalog.save({ ...fields, ...(project ? { id: project.id, revision } : {}) });
        dialog.close();
        onSaved(saved);
      } catch (reason) {
        error(reason);
        if (
          project &&
          reason.status === 409 &&
          reason.messageId === "projects.errorProjectsChangedInAnotherWindowReviewTheLatestInformationAndTryAgain" &&
          !dialog.querySelector(".project-reload")
        ) {
          const reload = document.createElement("button");
          reload.type = "button";
          reload.className = "wb-button project-reload";
          localizeText(reload, "projects.reloadLatestProjectDetails", undefined, t);
          reload.onclick = () => void edit(catalog.get(project.id));
          dialog.append(reload);
        }
      } finally {
        submit.disabled = false;
      }
    };
  }
  async function associate(projectId, sessionIds = null) {
    if (!catalog.ready) await catalog.load();
    const fixedProject = sessionIds === null;
    const selected = new Set(sessionIds || []),
      known = new Map(catalog.sessions().map((s) => [s.id, s]));
    let sessions = sessionIds ? sessionIds.map((id) => known.get(id) || { id, name: id }) : [],
      cursor = null,
      query = "",
      requestVersion = 0,
      busy = false,
      revision = catalog.revision;
    open(
      fixedProject ? "Link existing sessions" : "Change project",
      `<form id="projectAssociationForm" class="project-form">
      <label for="associationProject">${messageHtml("common.project", undefined, t)}</label><select id="associationProject" ${fixedProject ? "disabled" : ""}><option value="" data-pf-message="common.unassigned">${escape(t("common.unassigned"))}</option>${catalog
        .projects()
        .map(
          (p) =>
            `<option value="${escape(p.id)}" ${p.id === projectId ? "selected" : ""}>${escape(p.name)} · ${escape(p.code)}</option>`,
        )
        .join("")}</select>
      <p class="wb-help">${messageHtml("projects.linkingChangesOnlyTheProjectAssociationSessionContentsAndWorking", undefined, t)}</p>
      ${fixedProject ? `<label for="associationSearch">${messageHtml("common.searchSessions", undefined, t)}</label><input id="associationSearch" type="search" ${messageAttributes("placeholder", "projects.searchBySessionNameOrWorkingFolder", undefined, t)}>` : ""}
      <div id="associationSessions" class="project-session-picker"></div><button type="button" id="associationMore" class="wb-button" hidden>${messageHtml("projects.loadOlderSessions", undefined, t)}</button>
      <footer><span id="associationCount"></span><button type="submit" class="wb-button primary">${messageHtml(fixedProject ? "common.linkSelectedSessions" : "common.saveAssociation", undefined, t)}</button></footer></form>`,
    );
    const opened = generation,
      form = dialog.querySelector("form"),
      list = dialog.querySelector("#associationSessions"),
      more = dialog.querySelector("#associationMore"),
      submit = form.querySelector('[type="submit"]');
    function render() {
      setMessageHtml(
        list,
        sessions.length
          ? sessions
              .map((s) => {
                const current = catalog.projectForSession(s.id),
                  already = fixedProject && current?.id === projectId;
                return `<label class="project-session-option"><input type="checkbox" value="${escape(s.id)}" ${selected.has(s.id) ? "checked" : ""} ${already ? "disabled" : ""}><span data-i18n-ignore><strong>${escape(s.name || s.id)}</strong><small>${escape(s.cwd || t("common.noWorkingFolder"))}</small><small>${current ? escape(t("projects.currentlyInProject", { project: current.name })) : escape(t("common.unassigned"))}${already ? " · " + escape(t("projects.alreadyLinked")) : ""}</small></span></label>`;
              })
              .join("")
          : `<p class="wb-help">${messageHtml(busy ? "workbench.loadingSessions" : "common.noMatchingSessions", undefined, t)}</p>`,
      );
      more.hidden = !cursor;
      more.disabled = busy;
      submit.disabled = busy || selected.size === 0 || selected.size > 100;
      localizeText(
        dialog.querySelector("#associationCount"),
        "projects.countSessionsSelected",
        { count: selected.size },
        t,
      );
    }
    async function load(append = false) {
      const version = ++requestVersion;
      busy = true;
      render();
      try {
        const result = await catalog.history({ search: query, cursor: append ? cursor : "" });
        if (generation !== opened || version !== requestVersion) return;
        const merged = new Map((append ? sessions : []).map((s) => [s.id, s]));
        for (const s of result.sessions) {
          merged.set(s.id, s);
          known.set(s.id, s);
        }
        sessions = [...merged.values()];
        cursor = result.nextCursor;
      } catch (reason) {
        if (generation === opened && version === requestVersion) error(reason);
      } finally {
        if (generation === opened && version === requestVersion) {
          busy = false;
          render();
        }
      }
    }
    list.onchange = (event) => {
      const checkbox = event.target.closest('input[type="checkbox"]');
      if (!checkbox) return;
      if (checkbox.checked) selected.add(checkbox.value);
      else selected.delete(checkbox.value);
      render();
    };
    if (fixedProject) {
      let timer;
      dialog.querySelector("#associationSearch").oninput = (event) => {
        query = event.target.value;
        clearTimeout(timer);
        requestVersion++;
        timer = setTimeout(() => {
          if (generation === opened) void load();
        }, 250);
      };
      more.onclick = () => void load(true);
      void load();
    } else render();
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!selected.size || selected.size > 100) return;
      submit.disabled = true;
      try {
        const target = fixedProject ? projectId : dialog.querySelector("#associationProject").value || null;
        await catalog.assign(target, [...selected], revision);
        dialog.close();
        onAssigned?.();
      } catch (reason) {
        error(reason);
        revision = catalog.revision;
        render();
      }
    };
  }
  return { edit, associate };
}
