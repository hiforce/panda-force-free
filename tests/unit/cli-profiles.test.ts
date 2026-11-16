import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { CliProfiles } from "../../src/cli/profiles.js";
import { PandaClient } from "../../src/cli/client.js";
import { pandaIntegration } from "../../src/cli/integrations.js";
const registration = {
    schema: 1,
    protocol: 1,
    server: "https://panda.example",
    clientId: "client-1",
    kind: "claude",
    credentialRef: "credentials.json",
  },
  key = "pfk_" + "a".repeat(24) + "_" + "b".repeat(43);
test("registration is mandatory even for an environment key and binds credentials to one server", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-cli-profile-")),
    profiles = new CliProfiles(join(root, "private"));
  try {
    const fromRoot = new CliProfiles(join(root, "root-cwd"));
    await fromRoot.register("work", registration);
    const project = join(root, "project");
    await mkdir(project);
    await mkdir(join(project, ".git"));
    await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(project, ".git", "config"), "[core]\nbare = false\n");
    await expect(new CliProfiles(join(project, "config")).register("work", registration)).rejects.toThrow(
      "invalidInput",
    );
    const aliased = join(root, "aliased-project");
    await symlink(project, aliased);
    await expect(new CliProfiles(join(aliased, "private", "config")).register("work", registration)).rejects.toThrow(
      "invalidInput",
    );
    await expect(profiles.credentials("work", key)).rejects.toThrow("authenticationRequired");
    await expect(profiles.register("work", { ...registration, server: "http://public.example" })).rejects.toThrow(
      "invalidInput",
    );
    await profiles.register("work", registration);
    await profiles.login("work", key);
    await expect(profiles.register("work", { ...registration, server: "https://other.example" })).rejects.toThrow(
      "conflict",
    );
    const config = join(root, "private", "profiles", "work", "registration.json"),
      original = await readFile(config, "utf8");
    expect(original).not.toContain(key);
    await writeFile(config, JSON.stringify({ ...registration, server: "https://attacker.example" }));
    await expect(profiles.credentials("work", undefined)).rejects.toThrow("authenticationRequired");
    await writeFile(config, original);
    let sends = 0;
    const client = new PandaClient(profiles, "missing", async () => {
      sends++;
      throw new Error("No network call permitted");
    });
    await expect(client.request("session")).rejects.toThrow("authenticationRequired");
    expect(sends).toBe(0);
    await chmod(join(root, "private", "profiles", "work"), 0o777);
    await expect(profiles.credentials("work", key)).rejects.toThrow("authenticationRequired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("both agent skill installations are idempotent and preserve unrelated or edited files", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-agent-install-"));
  try {
    for (const target of ["codex", "claude"]) {
      const dir = join(root, target);
      await mkdir(dir);
      await writeFile(join(dir, "existing.json"), "preserved");
      await pandaIntegration("install", target, dir, "work");
      expect((await pandaIntegration("inspect", target, dir, "work")).installed).toBe(true);
      await pandaIntegration("install", target, dir, "work");
      const entry = join(dir, "panda", "SKILL.md");
      expect(await readFile(entry, "utf8")).toContain("panda auth status --profile work --json");
      expect(await readFile(entry, "utf8")).not.toContain(key);
      await writeFile(entry, "User customization");
      await expect(pandaIntegration("uninstall", target, dir, "work")).rejects.toThrow("conflict");
      expect(await readFile(entry, "utf8")).toBe("User customization");
      await rm(join(dir, "panda"), { recursive: true });
      await pandaIntegration("install", target, dir, "work");
      await pandaIntegration("uninstall", target, dir, "work");
      expect(await readFile(join(dir, "existing.json"), "utf8")).toBe("preserved");
    }
    const dir = join(root, "symlink-case");
    await pandaIntegration("install", "codex", dir, "work");
    await rm(join(dir, "panda", "references"), { recursive: true });
    await symlink(root, join(dir, "panda", "references"));
    await expect(pandaIntegration("uninstall", "codex", dir, "work")).rejects.toThrow("conflict");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a newer CLI can inspect and remove an unchanged older owned skill without deleting unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-agent-upgrade-"));
  try {
    await pandaIntegration("install", "claude", root, "work");
    const entry = join(root, "panda", "SKILL.md"),
      ownership = join(root, "panda", ".panda-install.json");
    const manifest = JSON.parse(await readFile(ownership, "utf8"));
    const historical = "---\nname: panda\ndescription: An older Panda agent entry.\n---\n";
    await writeFile(entry, historical);
    const retired = "Historical owned reference.";
    await writeFile(join(root, "panda", "references", "retired.md"), retired);
    manifest.files["references/retired.md"] = createHash("sha256").update(retired).digest("hex");
    manifest.files["SKILL.md"] = createHash("sha256").update(historical).digest("hex");
    await writeFile(ownership, JSON.stringify(manifest));
    await writeFile(join(root, "panda", "notes.txt"), "User note");
    const inspected = await pandaIntegration("inspect", "claude", root, "work");
    expect(inspected.installed).toBe(true);
    expect(inspected.updateAvailable).toBe(true);
    await pandaIntegration("uninstall", "claude", root, "work");
    expect(await readFile(join(root, "panda", "notes.txt"), "utf8")).toBe("User note");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
