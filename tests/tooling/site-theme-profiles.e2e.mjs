import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DockerBuildDriver } from "../../src/executor/docker/driver.js";
import { executorConfig } from "../../src/executor/config.js";
import { builtinSiteThemes } from "../../src/shared/presentation/themes.js";
import { freezeBuildTheme } from "../../src/shared/builds/theme.js";
import { freezePackageProfile } from "../../src/shared/builds/profile-theme.js";
import { PUBLIC_STYLE_SAMPLE } from "../../src/shared/presentation/sample-content.js";
import { siteSampleInput } from "../../src/server/plugins/integration/site-sample-input.js";
import { profileThemePackage } from "../support/profile-theme-package.js";

const image = process.env.PANDA_FORCE_WORKER_TEST_IMAGE;
if (!image) throw Error("Set PANDA_FORCE_WORKER_TEST_IMAGE to an explicitly selected local worker image.");
const evidenceDirectory = process.env.PANDA_FORCE_ENGINE_TEST_EVIDENCE_DIR || ".artifacts/site-theme-profiles";
await mkdir(evidenceDirectory, { recursive: true });
const driver = new DockerBuildDriver(
  executorConfig({
    PANDA_FORCE_HEXO_IMAGE: image,
    PANDA_FORCE_DOCUSAURUS_IMAGE: image,
    PANDA_FORCE_ENGINE_PULL_POLICY: "never",
    PANDA_FORCE_DOCKER_SOCKET: process.env.PANDA_FORCE_DOCKER_SOCKET,
  }),
  "theme-profile-" + randomUUID().slice(0, 8),
);
await driver.ready();
const verified = [];
for (const engine of ["hexo", "docusaurus"]) {
  const bundle = profileThemePackage(),
    custom = bundle.manifest.siteThemes.find((entry) => entry.engine === engine);
  custom.profile = { ...custom.profile, accent: "#1f6a8a", font: "serif", width: 940, density: "compact" };
  for (const [kind, theme] of [
    ["builtin", await freezeBuildTheme(builtinSiteThemes.resolve("default", engine))],
    ["profile", await freezePackageProfile(bundle, custom.id)],
  ]) {
    console.log(`${engine} ${kind}: building a fixed sample in a disposable worker`);
    const input = siteSampleInput(theme, { id: "native-sample", ...PUBLIC_STYLE_SAMPLE });
    let identity;
    const logs = [];
    const output = await driver.run(
      randomUUID(),
      input,
      AbortSignal.timeout(150000),
      (change) => {
        if (change.image) identity = change.image;
      },
      (text) => {
        if (logs.join("").length < 131072) logs.push(text);
      },
    );
    assert.ok(identity?.id.startsWith("sha256:"));
    const html = output.files
      .filter((file) => file.path.endsWith(".html"))
      .map((file) => Buffer.from(file.data, "base64").toString())
      .join("\n");
    const css = output.files
      .filter((file) => file.path.endsWith(".css"))
      .map((file) => Buffer.from(file.data, "base64").toString())
      .join("\n");
    for (const file of output.files)
      assert.equal(createHash("sha256").update(Buffer.from(file.data, "base64")).digest("hex"), file.sha256);
    assert.match(html, /Good writing makes complex ideas/);
    const styles = css + html;
    assert.ok(styles.includes(theme.profile.accent), "The actual output preserves the selected accent");
    assert.ok(styles.includes(theme.profile.width + "px"), "The actual output preserves the selected content width");
    if (kind === "profile") assert.match(styles, /Georgia/i);
    assert.equal(input.theme.package?.digest, kind === "profile" ? theme.package.digest : undefined);
    await writeFile(join(evidenceDirectory, `${engine}-${kind}.json`), JSON.stringify(output), { mode: 0o600 });
    await writeFile(join(evidenceDirectory, `${engine}-${kind}.log`), logs.join(""), { mode: 0o600 });
    verified.push({
      engine,
      kind,
      theme: theme.id,
      themeDigest: theme.sha256,
      packageDigest: theme.package?.digest || null,
      image: identity,
      files: output.files.length,
      bytes: output.bytes,
    });
  }
}
await writeFile(join(evidenceDirectory, "verified.json"), JSON.stringify({ image, verified }, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify({ image, verified }, null, 2));
