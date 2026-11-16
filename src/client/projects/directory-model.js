export const PROJECT_PAGE_SIZE = 24;

/** Search and order the loaded catalog without extra requests for individual projects. */
export function projectDirectoryPage(
  projects,
  { query = "", filter = "all", sort = "updated", page = 1, pinned, compare },
) {
  const normalize = (value) =>
    String(value || "")
      .normalize("NFKC")
      .toLocaleLowerCase();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const matches = projects.filter((project) => {
    if (filter === "pinned" && !pinned(project.id)) return false;
    const text = normalize([project.name, project.code, project.description].join(" "));
    return terms.every((term) => text.includes(term));
  });
  matches.sort(
    (a, b) =>
      Number(pinned(b.id)) - Number(pinned(a.id)) ||
      (sort === "updated"
        ? (b.updatedAt || 0) - (a.updatedAt || 0)
        : sort === "sessions"
          ? b.threads.length - a.threads.length
          : 0) ||
      compare(a.name, b.name) ||
      a.id.localeCompare(b.id),
  );
  const pages = Math.max(1, Math.ceil(matches.length / PROJECT_PAGE_SIZE));
  const current = Math.max(1, Math.min(pages, page));
  const start = (current - 1) * PROJECT_PAGE_SIZE;
  return {
    items: matches.slice(start, start + PROJECT_PAGE_SIZE),
    matches: matches.length,
    total: projects.length,
    pinnedCount: projects.filter((project) => pinned(project.id)).length,
    page: current,
    pages,
    start: matches.length ? start + 1 : 0,
    end: Math.min(start + PROJECT_PAGE_SIZE, matches.length),
  };
}
