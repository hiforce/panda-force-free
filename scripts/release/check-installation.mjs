import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAllDocuments, parse } from "yaml";
import { inputDigest } from "../build/creative-tools.mjs";

/** Keep released installation selectors coherent before users pull or build them. */
export function checkInstallation(root = process.cwd()) {
  const text = (path) => readFileSync(resolve(root, path), "utf8");
  const json = (path) => JSON.parse(text(path));
  const version = json("release/community/edition.json").version;
  const image = `hiforceai/panda-force:${version}`;
  const installClone = "git clone --branch main --depth 1 https://github.com/hiforce/panda-force-free.git";
  const bases = json("scripts/build/base-images.json");
  const require = (value, message) => {
    if (!value) throw Error(message);
  };
  require(json("package.json").version === version, "Application and community versions differ");
  require(bases.defaultProfile === "rocky9-creative", "Release must select the reviewed creative profile");
  require(bases.creativeInputsSha256 ===
    inputDigest(resolve(root, "scripts/build/creative-tools")), "Creative inputs differ from the release bases");
  for (const kind of ["build", "runtime"])
    require(new RegExp(`^hiforceai/panda-force-${kind}-base@sha256:[a-f0-9]{64}$`).test(
      bases[kind + "Base"],
    ), "Public base must use an immutable digest");
  for (const path of ["Dockerfile", "release/community/Dockerfile"]) {
    for (const [argument, key] of [
      ["BUILD_BASE", "buildBase"],
      ["RUNTIME_BASE", "runtimeBase"],
    ])
      require(text(path).split("\n").includes(`ARG ${argument}=${bases[key]}`), `${path}: mismatched ${argument}`);
  }
  for (const path of ["docker-compose.build.yml", "release/community/docker-compose.build.yml"]) {
    const args = parse(text(path)).services["panda-force"].build.args;
    for (const [argument, key] of [
      ["BUILD_BASE", "buildBase"],
      ["RUNTIME_BASE", "runtimeBase"],
    ])
      require(args[argument] === `\${PANDA_FORCE_${argument}:-${bases[key]}}`, `${path}: mismatched ${argument}`);
  }
  const compose = parse(text("release/community/docker-compose.yml"));
  require(compose.services["panda-force"].image ===
    `\${PANDA_FORCE_IMAGE:-${image}}`, "Compose application version differs");
  const grok = parse(text("deploy/harness/docker-compose.grok.yml"));
  require(!grok.services["panda-force"].image, "Grok overlay must inherit the selected application image");
  for (const name of ["grok-auth", "grok-auth-socket-init"])
    require(grok.services[name].image ===
      `\${PANDA_FORCE_HARNESS_IMAGE:-\${PANDA_FORCE_IMAGE:-${image}}}`, `${name}: mismatched release image`);
  require(grok.services["panda-force"].depends_on["grok-auth"].condition ===
    "service_healthy", "Application must wait for the account socket");
  const profiles = JSON.parse(grok.services["panda-force"].environment.PANDA_FORCE_HARNESS_PROFILES);
  require(profiles[0].credentialSocket ===
    grok.services["grok-auth"].environment.PANDA_FORCE_GROK_AUTH_SOCKET, "Grok socket paths differ");
  for (const mode of ["isolated", "shared", "cluster"])
    for (const document of parseAllDocuments(text(`panda-docs/static/downloads/kubernetes/panda-force-${mode}.yaml`))) {
      require(!document.errors.length, "Invalid Kubernetes template");
      const pod = document.toJS()?.spec?.template?.spec;
      if (pod)
        for (const container of [...(pod.initContainers || []), ...pod.containers])
          require(container.image === image, `${mode}: application/init image differs from release`);
    }
  for (const path of ["README.md", "README-zh.md", "release/community/README.md", "release/community/README-zh.md"])
    require(text(path).includes(installClone) &&
      text(path).includes(image) &&
      text(path).includes("Grok Build"), `${path}: incomplete release instructions`);
  for (const name of ["README.md", "README-zh.md"])
    require(text(name) === text("release/community/" + name), `${name}: public template differs`);
  for (const path of ["README.md", "README-zh.md", "release/community/README.md", "release/community/README-zh.md"])
    require(!/panda-force:local|docker-compose\.build\.yml|VERIFICATION_PROFILE/.test(
      text(path),
    ), `${path}: installation must link to developer build instructions instead of mixing them into the release flow`);
  for (const directory of ["panda-docs/docs", "panda-docs/i18n/zh-Hans/docusaurus-plugin-content-docs/current"])
    for (const name of readdirSync(resolve(root, directory)).filter(
      (name) => name.endsWith(".md") && name !== "releases.md",
    )) {
      const path = `${directory}/${name}`;
      for (const match of text(path).matchAll(/hiforceai\/panda-force:(\d+\.\d+\.\d+)/g))
        require(match[1] === version, `${path}: outdated application image in the documentation`);
      if (["installation.md", "harness-runtimes.md", "storage.md"].includes(name))
        require(!text(path).includes("panda-force:local"), `${path}: end-user instructions must use the release image`);
      if (["installation.md", "harness-runtimes.md"].includes(name))
        require(text(path).includes(installClone), `${path}: ordinary installation must clone the main branch`);
    }
  require(createHash("sha256").update(text("scripts/build/harness-engines.lock.json")).digest("hex") ===
    bases.engineLockSha256, "Harness lock differs from base metadata");
  return {
    passed: true,
    version,
    image,
    profile: bases.defaultProfile,
    matchedBaseSelectors: 4,
    grokHelpers: 2,
    kubernetesModes: 3,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(
    JSON.stringify(
      checkInstallation(process.argv[2] || resolve(fileURLToPath(new URL("../..", import.meta.url)))),
      null,
      2,
    ),
  );
