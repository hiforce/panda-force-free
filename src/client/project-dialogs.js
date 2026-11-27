import { escapeHtml as escape } from "../shared/html.js";
import { errorStatus } from "./../shared/errors.js";
import { closestElement, findElement, requireElement } from "./dom.js";
import { localizeText, messageAttributes, messageHtml, setMessageHtml, setOpaqueText } from "./i18n.js";

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
    requireElement("[data-project-close]", dialog).onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
  }
  function error(reason) {
    const el = findElement(".project-error", dialog);
    if (el) {
      el.hidden = false;
      localizeText(el, reason?.messageId || "errors.couldNotUpdateProject", reason?.messageArgs, t);
      el.tabIndex = -1;
      el.scrollIntoView({ block: "nearest" });
      el.focus({ preventScroll: true });
    }
  }
  dialog.addEventListener("close", () => {
    generation++;
    if (returnFocus?.isConnected) returnFocus.focus();
  });
  function projectMemberPicker(projectId) {
    const opened = generation;
    const root = /** @type {HTMLFieldSetElement} */ (requireElement("[data-project-members]", dialog));
    const list = requireElement("[data-project-member-list]", root);
    const status = requireElement("[data-project-member-status]", root);
    const retry = requireElement("[data-project-member-retry]", root);
    const save = /** @type {HTMLButtonElement | null} */ (findElement("[data-project-member-save]", root));
    const legacyNotice = requireElement("[data-project-legacy-members]", root);
    const ownerField = requireElement("[data-project-owner-field]", root);
    const ownerPicker = /** @type {HTMLSelectElement} */ (requireElement("[data-project-owner-picker]", root));
    const changes = new Map();
    let snapshot,
      busy = false;
    const notice = (id) => {
      if (id) localizeText(status, id, undefined, t);
      else status.textContent = "";
    };
    const selected = () =>
      (snapshot?.members || [])
        .filter((member) => !member.creator && (changes.get(member.id) ?? member.selected))
        .map((member) => member.id);
    function renderMembers() {
      setMessageHtml(
        list,
        (snapshot?.members || [])
          .map(({ id, username, selected, creator }) => {
            const locked = creator || (snapshot.chooseOwner && id === ownerPicker.value);
            return `<label class="project-session-option project-member-option"><input type="checkbox" value="${escape(id)}" ${locked || (changes.get(id) ?? selected) ? "checked" : ""} ${locked ? "disabled" : ""}><span><strong data-i18n-ignore>${escape(username)}</strong>${locked ? `<small>${messageHtml("projects.projectOwner", undefined, t)}</small>` : ""}</span></label>`;
          })
          .join(""),
      );
    }
    function render() {
      root.hidden = !snapshot.editable;
      legacyNotice.hidden = !snapshot.legacy;
      ownerField.hidden = !snapshot.chooseOwner;
      const previousOwner = ownerPicker.value;
      const empty = document.createElement("option");
      empty.value = "";
      localizeText(empty, "projects.chooseLegacyProjectOwner", undefined, t);
      ownerPicker.replaceChildren(empty);
      if (snapshot.chooseOwner) {
        for (const member of snapshot.members) {
          const option = document.createElement("option");
          option.value = member.id;
          setOpaqueText(option, member.username);
          ownerPicker.append(option);
        }
        ownerPicker.value = snapshot.members.some(({ id }) => id === previousOwner) ? previousOwner : "";
      }
      renderMembers();
      if (save) {
        save.hidden = snapshot.revision === null;
        localizeText(
          save,
          snapshot.legacy ? "projects.enableProjectMembers" : "projects.saveProjectMembers",
          undefined,
          t,
        );
      }
    }
    function setBusy(value) {
      busy = value;
      root.disabled = value;
      if (save)
        save.disabled =
          value ||
          !retry.hidden ||
          (!snapshot?.legacy && !changes.size) ||
          (snapshot?.chooseOwner && !ownerPicker.value);
    }
    ownerPicker.onchange = () => {
      renderMembers();
      setBusy(false);
    };
    async function load() {
      setBusy(true);
      retry.hidden = true;
      notice("projects.loadingProjectMembers");
      try {
        const result = await catalog.projectMembers(projectId);
        if (generation !== opened) return;
        snapshot = result;
        for (const [id, checked] of changes)
          if (!snapshot.members.some((member) => member.id === id && member.selected !== checked)) changes.delete(id);
        render();
        notice(!projectId && !snapshot.members.length ? "projects.noOtherProjectMembers" : null);
      } catch {
        if (generation !== opened) return;
        root.hidden = false;
        notice("projects.projectMembersUnavailable");
        retry.hidden = false;
      } finally {
        if (generation === opened) setBusy(false);
      }
    }
    retry.onclick = () => void load();
    list.onchange = (event) => {
      const checkbox = closestElement('input[type="checkbox"]', event.target);
      if (!checkbox || !snapshot || busy) return;
      const member = snapshot.members.find(({ id }) => id === checkbox.value);
      if (!member || member.creator) return;
      if (member.selected === checkbox.checked) changes.delete(member.id);
      else changes.set(member.id, checkbox.checked);
      if (retry.hidden) notice(null);
      setBusy(false);
    };
    if (save)
      save.onclick = async () => {
        if (busy || !snapshot || save.disabled) return;
        setBusy(true);
        notice("projects.savingProjectMembers");
        try {
          const result = await catalog.saveProjectMembers(
            projectId,
            snapshot.revision,
            selected(),
            snapshot.chooseOwner ? ownerPicker.value : undefined,
          );
          if (generation !== opened) return;
          snapshot = result;
          changes.clear();
          render();
          root.hidden = false;
          notice("projects.projectMembersSaved");
        } catch (reason) {
          if (generation !== opened) return;
          const stale = errorStatus(reason) === 409;
          retry.hidden = !stale;
          notice(stale ? "projects.projectMembersChanged" : "projects.projectMembersSaveFailed");
        } finally {
          if (generation === opened) setBusy(false);
        }
      };
    void load();
    return selected;
  }
  /** @param {import("../shared/data-contracts.js").ProductProject | null} project */
  async function edit(project = null) {
    if (!catalog.ready) await catalog.load();
    const revision = catalog.revision;
    const operationId = crypto.randomUUID();
    open(
      project ? "common.editProject" : "common.createProject",
      `<form id="projectForm" class="project-form">
      <label for="projectNameInput">${messageHtml("projects.projectName", undefined, t)}</label><input id="projectNameInput" name="projectName" required maxlength="100" autocomplete="off" value="${escape(project?.name || "")}">
      <label for="projectCodeInput">${messageHtml("projects.projectCode", undefined, t)}</label><input id="projectCodeInput" name="code" required minlength="2" maxlength="64" autocomplete="off" spellcheck="false" ${project?.workspace || project?.canManageMembers ? "readonly" : ""} value="${escape(project?.code || "")}"><p class="wb-help">${messageHtml(project?.workspace || project?.canManageMembers ? "projects.workspaceCodeLocked" : "projects.workspaceCodeHelp", undefined, t)}</p>
      <label for="projectDescriptionInput">${messageHtml("projects.descriptionOptional", undefined, t)}</label><textarea id="projectDescriptionInput" name="description" maxlength="2000" rows="4">${escape(project?.description || "")}</textarea>
      <fieldset class="project-member-picker" data-project-members ${project ? "hidden" : ""}>
        <legend>${messageHtml("projects.projectMembers", undefined, t)}</legend>
        <p class="wb-help">${messageHtml("projects.projectMembersHint", undefined, t)}</p>
        <p class="wb-help" data-project-legacy-members hidden>${messageHtml("projects.legacyProjectMembersHint", undefined, t)}</p>
        <label class="wb-field project-owner-field" data-project-owner-field hidden><span>${messageHtml("projects.legacyProjectOwnerHint", undefined, t)}</span><select data-project-owner-picker></select></label>
        <div class="project-session-picker" data-project-member-list></div>
        <p class="wb-help" data-project-member-status role="status"></p>
        <button type="button" class="wb-button" data-project-member-retry hidden>${messageHtml("common.retry", undefined, t)}</button>
        ${project ? `<button type="button" class="wb-button" data-project-member-save hidden>${messageHtml("projects.saveProjectMembers", undefined, t)}</button>` : ""}
      </fieldset>
      <footer><button type="submit" class="wb-button primary">${messageHtml(project ? "common.saveProject" : "common.createProject", undefined, t)}</button></footer></form>`,
    );
    requireElement("#projectNameInput", dialog).focus();
    const selectedMembers = projectMemberPicker(project?.id);
    requireElement("form", dialog).onsubmit = async (event) => {
      event.preventDefault();
      const form = requireElement("form", dialog),
        submit = requireElement('[type="submit"]', form);
      submit.disabled = true;
      try {
        const fields = Object.fromEntries(new FormData(form));
        fields.name = fields.projectName;
        delete fields.projectName;
        const saved = await catalog.save({
          ...fields,
          ...(project ? { id: project.id, revision } : { operationId, members: selectedMembers() }),
        });
        dialog.close();
        onSaved(saved);
      } catch (reason) {
        error(reason);
        if (
          project &&
          errorStatus(reason) === 409 &&
          typeof reason === "object" &&
          reason !== null &&
          "messageId" in reason &&
          reason.messageId === "projects.errorProjectsChangedInAnotherWindowReviewTheLatestInformationAndTryAgain" &&
          !findElement(".project-reload", dialog)
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
  /** @param {string | null} projectId @param {string[] | null} sessionIds */
  async function associate(projectId, sessionIds = null) {
    if (!catalog.ready) await catalog.load();
    const fixedProject = sessionIds === null;
    const selected = new Set(sessionIds || []),
      known = new Map(catalog.sessions().map((s) => [s.id, s]));
    let sessions = sessionIds ? sessionIds.map((id) => known.get(id) || { id, name: id }) : [],
      cursor = null,
      query = "",
      directory,
      requestVersion = 0,
      busy = false,
      saving = false,
      revision = catalog.revision;
    open(
      fixedProject ? "common.linkExistingSessions" : "projects.linkSessionToProject",
      `<form id="projectAssociationForm" class="project-form">
      ${fixedProject ? "" : `<label class="sr-only" for="associationProjectSearch">${messageHtml("sessionview.searchProjects", undefined, t)}</label><input id="associationProjectSearch" type="search" ${messageAttributes("placeholder", "sessionview.searchProjects", undefined, t)} />`}
      <label for="associationProject">${messageHtml("common.project", undefined, t)}</label><select id="associationProject" ${fixedProject ? "disabled" : ""}><option value="" data-pf-message="projects.chooseProjectToLink">${escape(t("projects.chooseProjectToLink"))}</option>${catalog
        .projects()
        .map(
          (p) =>
            `<option value="${escape(p.id)}" ${p.id === projectId ? "selected" : ""}>${escape(p.name)} · ${escape(p.code)}</option>`,
        )
        .join("")}</select>
      <p class="wb-help">${messageHtml("projects.firstLinkIsPermanent", undefined, t)}</p>
      ${fixedProject ? `<label for="associationSearch">${messageHtml("common.searchSessions", undefined, t)}</label><input id="associationSearch" type="search" ${messageAttributes("placeholder", "projects.searchBySessionNameOrWorkingFolder", undefined, t)}><label for="associationDirectory">${messageHtml("sessions.byDirectory", undefined, t)}</label><select id="associationDirectory" class="project-directory-filter" disabled><option value="*">${messageHtml("sessions.loadingDirectories", undefined, t)}</option></select><p id="associationDirectoryStatus" class="wb-help" role="status"></p>` : ""}
      <div id="associationSessions" class="project-session-picker" ${fixedProject ? "" : "hidden"}></div><button type="button" id="associationMore" class="wb-button" hidden>${messageHtml("projects.loadOlderSessions", undefined, t)}</button>
      <footer><span id="associationCount" ${fixedProject ? "" : "hidden"}></span><button type="submit" class="wb-button primary">${messageHtml(fixedProject ? "common.linkSelectedSessions" : "common.saveAssociation", undefined, t)}</button></footer></form>`,
    );
    const opened = generation,
      form = requireElement("form", dialog),
      list = requireElement("#associationSessions", dialog),
      more = requireElement("#associationMore", dialog),
      submit = requireElement('[type="submit"]', form);
    const projectSearch = findElement("#associationProjectSearch", dialog);
    if (projectSearch)
      projectSearch.oninput = () => {
        const selector = requireElement("#associationProject", dialog),
          value = selector.value;
        const query = projectSearch.value.trim().toLocaleLowerCase();
        const entries = catalog
          .projects()
          .filter((project) => `${project.name} ${project.code}`.toLocaleLowerCase().includes(query));
        const current = catalog.get(value);
        if (current && !entries.some((project) => project.id === value)) entries.unshift(current);
        const empty = document.createElement("option");
        empty.value = "";
        localizeText(empty, "projects.chooseProjectToLink", undefined, t);
        selector.replaceChildren(empty);
        for (const project of entries) {
          const option = document.createElement("option");
          option.value = project.id;
          setOpaqueText(option, `${project.name} · ${project.code}`);
          selector.append(option);
        }
        selector.value = value;
        render();
      };
    function render() {
      const available = fixedProject ? sessions.filter((item) => !catalog.assignment(item.id)) : sessions;
      if (fixedProject) for (const id of selected) if (catalog.assignment(id)) selected.delete(id);
      if (fixedProject)
        setMessageHtml(
          list,
          available.length
            ? available
                .map((s) => {
                  return `<label class="project-session-option"><input type="checkbox" value="${escape(s.id)}" ${selected.has(s.id) ? "checked" : ""} ${saving ? "disabled" : ""}><span data-i18n-ignore><strong>${escape(s.name || s.id)}</strong><small>${escape(s.cwd || t("common.noWorkingFolder"))}</small></span></label>`;
                })
                .join("")
            : `<p class="wb-help">${messageHtml(busy ? "workbench.loadingSessions" : "common.noMatchingSessions", undefined, t)}</p>`,
        );
      more.hidden = !cursor;
      more.disabled = busy;
      const selectProject = requireElement("#associationProject", dialog);
      submit.disabled = busy || saving || selected.size === 0 || selected.size > 100 || !selectProject.value;
      form.setAttribute("aria-busy", String(saving));
      requireElement("#associationProject", dialog).disabled = fixedProject || saving;
      localizeText(
        submit,
        saving ? "projects.savingAssociation" : fixedProject ? "common.linkSelectedSessions" : "common.saveAssociation",
        undefined,
        t,
      );
      localizeText(
        findElement("#associationCount", dialog),
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
        const result = await catalog.history({ search: query, directory, cursor: append ? cursor : "" });
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
      const checkbox = closestElement('input[type="checkbox"]', event.target);
      if (!checkbox) return;
      if (checkbox.checked) selected.add(checkbox.value);
      else selected.delete(checkbox.value);
      render();
    };
    if (fixedProject) {
      const selector = requireElement("#associationDirectory", dialog);
      void catalog.directoryIndex
        .read()
        .then((entries) => {
          if (generation !== opened) return;
          selector.replaceChildren();
          const all = document.createElement("option");
          all.value = "*";
          localizeText(all, "sessions.allDirectories", undefined, t);
          selector.append(all);
          for (const entry of entries) {
            const option = document.createElement("option");
            option.value = JSON.stringify(entry.path);
            setOpaqueText(option, (entry.path || t("common.noWorkingFolder")) + " (" + entry.count + ")");
            selector.append(option);
          }
          selector.disabled = false;
        })
        .catch(() => {
          if (generation !== opened) return;
          const all = document.createElement("option");
          all.value = "*";
          localizeText(all, "sessions.allDirectories", undefined, t);
          selector.replaceChildren(all);
          localizeText(
            requireElement("#associationDirectoryStatus", dialog),
            "sessions.directoryLoadFailed",
            undefined,
            t,
          );
        });
      selector.onchange = () => {
        directory = selector.value === "*" ? undefined : JSON.parse(selector.value);
        cursor = null;
        void load();
      };
      let timer;
      requireElement("#associationSearch", dialog).oninput = (event) => {
        query = requireElement("#associationSearch", dialog).value;
        clearTimeout(timer);
        requestVersion++;
        timer = setTimeout(() => {
          if (generation === opened) void load();
        }, 250);
      };
      more.onclick = () => void load(true);
      void load();
    } else {
      requireElement("#associationProject", dialog).onchange = render;
      render();
    }
    form.onsubmit = async (event) => {
      event.preventDefault();
      const target = fixedProject ? projectId : requireElement("#associationProject", dialog).value;
      if (saving || busy || !target || !selected.size || selected.size > 100) return;
      saving = true;
      render();
      try {
        await catalog.assign(target, [...selected], revision);
        if (generation === opened) dialog.close();
        onAssigned?.();
      } catch (reason) {
        if (generation === opened) {
          error(reason);
          revision = catalog.revision;
        }
      } finally {
        if (generation === opened) {
          saving = false;
          render();
        }
      }
    };
  }
  return { edit, associate };
}
