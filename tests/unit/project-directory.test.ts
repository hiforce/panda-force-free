import { expect, test } from "bun:test";
import { projectDirectoryPage, PROJECT_PAGE_SIZE } from "../../src/client/projects/directory-model.js";

const projects = Array.from({ length: 57 }, (_, i) => ({
  id: String(i),
  name: "Project " + String(i).padStart(2, "0"),
  code: "team-" + i,
  description: i % 2 ? "Research notes" : "Release planning",
  updatedAt: i,
  threads: Array.from({ length: i % 5 }),
}));
const options = { pinned: (id: string) => id === "3", compare: (a: string, b: string) => a.localeCompare(b) };

test("directory search matches all words across name, code and description without changing the catalog", () => {
  const result = projectDirectoryPage(projects, { ...options, query: "ＴＥＡＭ-3 research" });
  expect(result.items.map((p) => p.id)).toEqual(["3", "39", "37", "35", "33", "31"]);
  expect(projects[0].id).toBe("0");
  expect(result.matches).toBe(6);
});

test("pinned projects lead every ordering and a pinned-only filter is independent of ordering", () => {
  for (const sort of ["updated", "name", "sessions"]) {
    const result = projectDirectoryPage(projects, { ...options, sort });
    expect(result.items[0].id).toBe("3");
    expect(result.items[1].id).toBe(sort === "updated" ? "56" : sort === "name" ? "0" : "4");
  }
  const pinned = projectDirectoryPage(projects, { ...options, filter: "pinned", query: "research" });
  expect(pinned.items.map((p) => p.id)).toEqual(["3"]);
  expect(pinned.pinnedCount).toBe(1);
});

test("pagination bounds rendered work and clamps pages after filters or catalog changes", () => {
  const second = projectDirectoryPage(projects, { ...options, sort: "name", page: 2 });
  expect(second.items).toHaveLength(PROJECT_PAGE_SIZE);
  expect([second.start, second.end, second.pages]).toEqual([25, 48, 3]);
  expect(
    new Set(
      [
        ...projectDirectoryPage(projects, options).items,
        ...projectDirectoryPage(projects, { ...options, page: 2 }).items,
      ].map((p) => p.id),
    ).size,
  ).toBe(48);
  expect(projectDirectoryPage(projects, { ...options, page: 99 }).page).toBe(3);
  expect(projectDirectoryPage(projects, { ...options, page: 3, query: "not present" })).toMatchObject({
    page: 1,
    pages: 1,
    start: 0,
    end: 0,
    matches: 0,
    items: [],
  });
});
