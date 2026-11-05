import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectVisibilityStore } from "../src/server/misc/project-visibility.js";
import { normalizeProjectVisibilityKey } from "../src/shared/project-visibility.js";

test("explicit project visibility persists separately from legacy folder identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "panda-visibility-key-")),
    path = join(directory, "visibility.json");
  try {
    const store = new ProjectVisibilityStore(path, directory);
    store.setHidden("project:fixture-id", true);
    store.setHidden("~/workspace", true);
    const reloaded = new ProjectVisibilityStore(path, directory),
      snapshot = reloaded.snapshot();
    expect(Object.keys(snapshot.hiddenProjects).sort()).toEqual(
      [directory + "/workspace", "project:fixture-id"].sort(),
    );
    expect(
      reloaded.setHidden("project:fixture-id", false, snapshot.hiddenProjects["project:fixture-id"].hiddenAt),
    ).toBe(true);
    expect(reloaded.snapshot().hiddenProjects["project:fixture-id"]).toBeUndefined();
    for (const value of ["project:../escape", "project:", "project:<script>", "project:a/b"])
      expect(normalizeProjectVisibilityKey(value)).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
