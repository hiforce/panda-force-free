import { errorText, getBrowserI18n } from "./i18n.js";
export function createProjectCatalog({ state, onChange = () => {} }) {
  let snapshot = { revision: -1, projects: [], assignments: [] },
    loading = null;
  let projects = new Map(),
    assignments = new Map();
  const pendingAssignments = new Map();
  function apply(value) {
    if (
      !Number.isSafeInteger(value?.revision) ||
      value.revision < snapshot.revision ||
      !Array.isArray(value.projects) ||
      !Array.isArray(value.assignments)
    )
      return;
    snapshot = value;
    projects = new Map(value.projects.map((p) => [p.id, p]));
    assignments = new Map(value.assignments.map((s) => [s.id, s]));
    onChange();
  }
  async function read(path, options) {
    const response = await fetch(path, { cache: "no-store", ...options });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 409) await load();
      throw Object.assign(new Error(errorText(data, getBrowserI18n().t, "errors.couldNotUpdateProject")), {
        status: response.status,
        messageId: data.messageId,
        messageArgs: data.messageArgs,
      });
    }
    return data;
  }
  function load() {
    return (loading ||= read("/api/projects")
      .then(apply)
      .finally(() => {
        loading = null;
      }));
  }
  function sessions() {
    const merged = new Map(state.threads.map((s) => [s.id, s]));
    for (const s of assignments.values()) if (!merged.has(s.id)) merged.set(s.id, { ...s, status: { type: "idle" } });
    return [...merged.values()];
  }
  function list() {
    const grouped = new Map([...projects].map(([id, p]) => [id, { ...p, threads: [] }]));
    for (const s of sessions()) grouped.get(assignments.get(s.id)?.projectId)?.threads.push(s);
    return [...grouped.values()];
  }
  async function mutate(path, body, method = "POST") {
    if (snapshot.revision < 0) await load();
    const data = await read(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: snapshot.revision, ...body }),
    });
    apply(data);
    return data;
  }
  return {
    apply,
    load,
    sessions,
    projects: list,
    get: (id) => projects.get(id),
    projectForSession: (id) => projects.get(assignments.get(id)?.projectId),
    assignment: (id) => assignments.get(id),
    get ready() {
      return snapshot.revision >= 0;
    },
    get revision() {
      return snapshot.revision;
    },
    async save(fields) {
      const result = await mutate("/api/projects", fields, fields.id ? "PATCH" : "POST");
      return result.projects.find((p) =>
        fields.id ? p.id === fields.id : p.code === fields.code.trim().toLowerCase(),
      );
    },
    assign: (projectId, sessionIds, revision) =>
      mutate("/api/projects/assign", { projectId, sessionIds, ...(revision !== undefined ? { revision } : {}) }),
    history: ({ search = "", cursor = "" } = {}) =>
      read("/api/projects/history?" + new URLSearchParams({ search, cursor })),
    pendingAssignments,
    async finishAssignment(thread) {
      if (!pendingAssignments.has(thread.id)) return;
      const id = pendingAssignments.get(thread.id);
      await this.assign(id, [thread.id]);
      pendingAssignments.delete(thread.id);
    },
  };
}
