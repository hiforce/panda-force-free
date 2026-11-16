import { isRecord } from "../../shared/records.js";
import type { SystemGadgetPorts, GadgetRow } from "./ports.js";
import type { TemplateCatalog } from "../../server/templates/catalog.js";
import type { ProjectSnapshot } from "../../shared/engine/types.js";
export function systemGadgetPorts(options: {
  snapshot(): Promise<ProjectSnapshot> | ProjectSnapshot;
  sessions(): Promise<unknown>;
  visible(session: unknown): boolean;
  projectAccess(owner: string, id: string): Promise<void>;
  skills: TemplateCatalog;
  bots(owner: string): Promise<unknown>;
}): SystemGadgetPorts {
  let cache: Promise<unknown> | undefined,
    expires = 0;
  async function sessions(owner: string, limit: number) {
    if (!cache || Date.now() > expires) {
      expires = Date.now() + 10000;
      cache = options.sessions().catch((error) => {
        cache = undefined;
        throw error;
      });
    }
    const value = await cache,
      raw = isRecord(value) && Array.isArray(value.data) ? value.data : [],
      snapshot = await options.snapshot(),
      rows: GadgetRow[] = [];
    for (const s of raw.slice(0, 20)) {
      if (!isRecord(s) || typeof s.id !== "string" || !options.visible(s)) continue;
      const assignment = snapshot.assignments.find((a) => a.id === s.id),
        project = snapshot.projects.find((p) => p.id === assignment?.projectId);
      if (project)
        try {
          await options.projectAccess(owner, project.id);
        } catch {
          continue;
        }
      const status = isRecord(s.status) ? s.status : {},
        flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
      rows.push({
        id: s.id,
        title: String(s.name || s.preview || ""),
        description: project?.name || "",
        updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : undefined,
        status: flags.some((f) => /approval|input/i.test(String(f)))
          ? "review"
          : status.type === "active"
            ? "running"
            : status.type === "systemError"
              ? "error"
              : "ready",
      });
      if (rows.length >= limit) break;
    }
    return rows;
  }
  return {
    authorize: (owner) => !!owner,
    sessions,
    attention: async (owner, limit) => (await sessions(owner, 20)).filter((s) => s.status === "review").slice(0, limit),
    projects: async (owner, limit) => {
      const snapshot = await options.snapshot(),
        rows: GadgetRow[] = [];
      for (const p of snapshot.projects) {
        try {
          await options.projectAccess(owner, p.id);
        } catch {
          continue;
        }
        rows.push({ id: p.id, title: p.name, description: p.code, updatedAt: p.updatedAt });
        if (rows.length >= limit) break;
      }
      return rows;
    },
    skills: async (owner, limit) => {
      const page = await options.skills.list(
        { domain: "skills", state: "enabled", view: "gallery", limit, order: "purpose" },
        owner,
      );
      return page.templates.map((item) => ({
        id: item.key,
        title: item.label.name || item.key,
        template: item,
        description: "",
        version: item.reference.version,
        ...(item.label.nameId ? { titleId: item.label.nameId } : {}),
      }));
    },
    bots: options.bots,
  };
}
