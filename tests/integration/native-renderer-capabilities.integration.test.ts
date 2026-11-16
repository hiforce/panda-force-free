import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { nativeSampleFixture } from "../support/native-sample-fixture.js";
import { nativeProjectBuildFixture } from "../support/native-project-build-fixture.js";
import { nativeFiles, nativeZipSource } from "../support/native-theme.js";
import { HEXO_STYLUS_PROTOCOL } from "../../src/shared/builds/capabilities.js";

const styledSource = () => nativeZipSource({ ...nativeFiles, "theme/source/css/style.styl": "body\n  color red" });

test("native sample admission rejects missing renderer support without reserving a durable job", async () => {
  const f = await nativeSampleFixture();
  try {
    const { source } = await styledSource(),
      command = await f.themes.command(f.themeService, source),
      installed = await f.themeService.install("owner", command.input),
      value = installed.current.themes[0]!,
      request = { id: randomUUID(), theme: { id: value.id, version: value.version, digest: value.digest } };
    await expect(f.samples.start("owner", request)).rejects.toThrow("hexoStylusWorkerRequired");
    expect(f.jobs.list("owner")).toEqual([]);
    expect(f.executor.starts).toBe(0);
    f.executor.available.hexoStylus = true;
    expect((await f.samples.start("owner", request)).id).toBe(request.id);
    expect(f.jobs.list("owner")).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

test("saved project builds detect renderer requirements before persisting a reservation or starting execution", async () => {
  const f = await nativeProjectBuildFixture();
  try {
    const { source } = await styledSource(),
      command = await f.native.command(f.themes, source),
      installed = await f.themes.install(f.actor, command.input),
      theme = installed.current.themes[0]!;
    await f.place();
    const request = f.request({ id: theme.id, version: theme.version, digest: theme.digest });
    f.executor.faults.disabledFeatures.add(HEXO_STYLUS_PROTOCOL);
    const denied = await f.f.call("/api/site-builds", "POST", request);
    expect(denied.status).toBe(503);
    expect(denied.body.messageId).toBe("builds.hexoStylusWorkerRequired");
    expect(f.db.query<{ count: number }, []>("SELECT count(*) AS count FROM site_builds").get()!.count).toBe(0);
    expect(f.executor.inputs.size).toBe(0);
    f.executor.faults.disabledFeatures.delete(HEXO_STYLUS_PROTOCOL);
    f.executor.faults.statusUnavailable = true;
    const accepted = await f.f.call("/api/site-builds", "POST", request);
    expect(accepted.status).toBe(202);
    expect(accepted.body.build.id).toBe(request.id);
  } finally {
    await f.close();
  }
});
