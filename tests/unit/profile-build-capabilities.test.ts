import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileThemePackage } from "../support/profile-theme-package.js";
import { freezePackageProfile } from "../../src/shared/builds/profile-theme.js";
import { freezeBuildTheme } from "../../src/shared/builds/theme.js";
import { builtinSiteThemes } from "../../src/shared/presentation/themes.js";
import { buildRequirements } from "../../src/shared/builds/capabilities.js";
import { PROFILE_THEME_PROTOCOL } from "../../src/shared/builds/profile-identity.js";
import { THEME_PROTOCOL } from "../../src/shared/builds/theme.js";
import { executionFailure } from "../../src/shared/builds/failures.js";
import type { BuildInput } from "../../src/shared/builds/contracts.js";
import { HttpSiteExecutor } from "../../src/server/builds/adapters/http-executor.js";
import { SiteBuildService } from "../../src/server/builds/service.js";
import { SiteBuildRepository } from "../../src/server/builds/repository.js";
import { SiteBuildArtifacts } from "../../src/server/builds/artifacts.js";
import { resolveWorkerImage } from "../../src/executor/docker/images.js";
import type { DockerApi } from "../../src/executor/docker/api.js";

const input: BuildInput = {
  protocol: 1,
  engine: "hexo",
  preset: "reader",
  site: { title: "Sample", url: "https://example.test", basePath: "/", locale: "en" },
  documents: [{ id: "sample", path: "sample.md", title: "Sample", content: "A public sample" }],
  assets: [],
};
test("old executors remain usable for built-ins but cannot accept a package profile without its protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-capabilities-")),
    db = new Database(":memory:");
  try {
    const token = join(root, "token");
    await writeFile(token, "a".repeat(64));
    let features = [THEME_PROTOCOL];
    const remote = new HttpSiteExecutor("http://127.0.0.1:1234", token, async () =>
      Response.json({
        protocol: 1,
        engines: { hexo: "8.1.1" },
        features,
      }),
    );
    const builtin = await freezeBuildTheme(builtinSiteThemes.resolve("default", "hexo")),
      profile = await freezePackageProfile(profileThemePackage(), "journal"),
      jobs = new SiteBuildRepository(db),
      spaceId = randomUUID();
    let theme = builtin;
    const service = new SiteBuildService(
      {
        authorize() {},
        async capture() {
          return { input: { ...input, theme }, sources: [] };
        },
      },
      jobs,
      new SiteBuildArtifacts(root),
      remote,
      null,
      () => {},
    );
    expect((await remote.availability()).profileThemes).toBe(false);
    expect((await service.start({ id: randomUUID(), spaceId, engine: "hexo", ...input.site })).phase).toBe("queued");
    theme = profile;
    const denied = randomUUID();
    await expect(service.start({ id: denied, spaceId, engine: "hexo", ...input.site })).rejects.toThrow(
      "profileThemeExecutorRequired",
    );
    expect(jobs.list(spaceId).map((job) => job.id)).not.toContain(denied);
    features = [...features, PROFILE_THEME_PROTOCOL];
    expect((await remote.availability()).profileThemes).toBe(true);
    const accepted = await service.start({ id: randomUUID(), spaceId, engine: "hexo", ...input.site });
    expect(jobs.input(accepted.id).theme?.package).toEqual(profile.package);
    expect(buildRequirements({ ...input, theme: profile })).toEqual({
      themes: true,
      profileThemes: true,
      trustedThemes: false,
      siteProjects: false,
    });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("profile workers require a separate label while registry overrides and old built-in support remain valid", async () => {
  for (const engine of ["hexo", "docusaurus"] as const) {
    const labels: Record<string, string> = {
      "ai.hiforce.panda.build-protocol": "1",
      "ai.hiforce.panda.theme-protocol": "1",
      [`ai.hiforce.panda.engine.${engine}`]: engine === "hexo" ? "8.1.1" : "3.10.2",
    };
    const api = {
      call: async () => ({
        status: 200,
        data: Buffer.from(JSON.stringify({ Id: "sha256:" + "a".repeat(64), Config: { Labels: labels } })),
      }),
    } as unknown as DockerApi;
    const selection = { reference: "harbor.example.test/team/custom-worker:3", pullPolicy: "never" as const };
    await expect(
      resolveWorkerImage(api, selection, engine, { requirements: { themes: true, profileThemes: true } }),
    ).rejects.toThrow("profileThemeWorkerRequired");
    expect((await resolveWorkerImage(api, selection, engine, { requirements: { themes: true } })).reference).toBe(
      selection.reference,
    );
    labels["ai.hiforce.panda.profile-theme-protocol"] = "1";
    expect(
      (await resolveWorkerImage(api, selection, engine, { requirements: { themes: true, profileThemes: true } })).id,
    ).toBe("sha256:" + "a".repeat(64));
  }
  expect(executionFailure("profileThemeWorkerRequired")).toBe("profileThemeWorkerRequired");
});
