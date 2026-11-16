interface Session {
  id: string;
  cwd?: string | null;
}
interface Project {
  id: string;
  name: string;
  code?: string;
}
export interface SidebarSessionGroup<T> {
  key: string;
  threads: T[];
  visibleThreads: T[];
  limit: number;
  hasMore: boolean;
  expanded: boolean;
  pinned: boolean;
  pinnedGroup: boolean;
}
interface GroupOptions<T extends Session> {
  sessions: readonly T[];
  allSessions: readonly T[];
  projects?: readonly Project[];
  query: string;
  hidden: Readonly<Record<string, unknown>>;
  pinnedSessions: ReadonlySet<string>;
  pinnedProjects: ReadonlySet<string>;
  expansion: Readonly<Record<string, boolean>>;
  activeSession?: string;
  currentProject: string;
  pageSize: number;
  limits: ReadonlyMap<string, number>;
  projectKey(session: T): string;
  projectName(key: string): string;
  title(session: T): string;
  activity(session: T): number;
  compare(left: string, right: string): number;
}

/** Selection and pagination never mutate session records or depend on DOM/menu lifecycle. */
export function sidebarSessionGroups<T extends Session>(options: GroupOptions<T>): SidebarSessionGroup<T>[] {
  const q = options.query.trim().toLowerCase(),
    groups = new Map<string, { key: string; threads: T[] }>(),
    visible = (key: string) => !Object.hasOwn(options.hidden, key),
    matches = (session: T) =>
      !q || options.title(session).toLowerCase().includes(q) || !!session.cwd?.toLowerCase().includes(q);
  for (const session of options.sessions) {
    const key = options.projectKey(session);
    if (
      visible(key) &&
      (matches(session) || (options.projects && options.projectName(key).toLowerCase().includes(q)))
    ) {
      const group = groups.get(key) ?? { key, threads: [] };
      group.threads.push(session);
      groups.set(key, group);
    }
  }
  if (options.projects) {
    for (const project of options.projects) {
      const key = "project:" + project.id;
      if (visible(key) && !groups.has(key) && (!q || [project.name, project.code].join(" ").toLowerCase().includes(q)))
        groups.set(key, { key, threads: [] });
    }
    // Unassigned history remains discoverable even when the loaded page contains only linked sessions.
    if (visible("__tasks__") && !groups.has("__tasks__")) groups.set("__tasks__", { key: "__tasks__", threads: [] });
  }
  const pinned = options.allSessions.filter((session) => options.pinnedSessions.has(session.id) && matches(session));
  if (!q || pinned.length) groups.set("__pinned__", { key: "__pinned__", threads: pinned });
  return [...groups.values()]
    .sort((left, right) => {
      if ((left.key === "__pinned__") !== (right.key === "__pinned__")) return left.key === "__pinned__" ? -1 : 1;
      if (options.pinnedProjects.has(left.key) !== options.pinnedProjects.has(right.key))
        return options.pinnedProjects.has(left.key) ? -1 : 1;
      return (
        options.compare(options.projectName(left.key), options.projectName(right.key)) ||
        left.key.localeCompare(right.key)
      );
    })
    .map((group) => {
      const threads = group.threads.sort((left, right) => options.activity(right) - options.activity(left)),
        limit = group.key === "__tasks__" && options.projects ? 10 : options.limits.get(group.key) || options.pageSize,
        visibleThreads = q ? threads : threads.slice(0, limit);
      return {
        ...group,
        threads,
        visibleThreads,
        limit,
        hasMore: !(options.projects && group.key === "__tasks__") && visibleThreads.length < threads.length,
        pinnedGroup: group.key === "__pinned__",
        pinned: options.pinnedProjects.has(group.key),
        expanded:
          group.key === "__pinned__" ||
          !!q ||
          (Object.hasOwn(options.expansion, group.key)
            ? options.expansion[group.key]!
            : threads.some((session) => session.id === options.activeSession) || group.key === options.currentProject),
      };
    });
}
