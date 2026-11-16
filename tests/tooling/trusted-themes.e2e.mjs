import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { freezeTrustedBuildTheme } from "../../src/shared/builds/trusted-theme.js";

const image = process.env.PANDA_FORCE_WORKER_TEST_IMAGE;
if (!image) throw Error("Set PANDA_FORCE_WORKER_TEST_IMAGE to a verified local worker image.");
const evidence = [];
for (const [engine, exportId] of [
  ["hexo", "journal"],
  ["docusaurus", "reference"],
]) {
  const value = exampleThemePackage(),
    large = Buffer.alloc(1024 * 1024, "a");
  value.files.push({
    path: "hexo/source/large sample.txt",
    data: large.toString("base64"),
    sha256: createHash("sha256").update(large).digest("hex"),
  });
  const theme = await freezeTrustedBuildTheme(value, exportId),
    input = {
      protocol: 1,
      engine,
      preset: engine === "hexo" ? "reader" : "handbook",
      theme,
      site: { title: "Trusted theme fixture", url: "https://example.test", basePath: "/guide/", locale: "en" },
      documents: [
        {
          id: "article",
          path: "article.md",
          title: "Fixture article",
          content: "# Original source\n\nA clear saved article.\n",
        },
      ],
      assets: [],
    };
  const process = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--memory",
      "2g",
      "--cpus",
      "2",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=268435456,mode=1777",
      "--tmpfs",
      "/work:rw,nosuid,nodev,size=805306368,uid=1000,gid=1000,mode=0700",
      image,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 150000 },
  );
  process.stdin.write(JSON.stringify(input) + "\n");
  process.stdin.end();
  const [output, error, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  assert.equal(code, 0, error.slice(-12000));
  const artifact = JSON.parse(output);
  for (const file of artifact.files)
    assert.equal(createHash("sha256").update(Buffer.from(file.data, "base64")).digest("hex"), file.sha256);
  const html = artifact.files
      .filter((file) => file.path.endsWith(".html"))
      .map((file) => Buffer.from(file.data, "base64").toString())
      .join("\n"),
    css = artifact.files
      .filter((file) => file.path.endsWith(".css"))
      .map((file) => Buffer.from(file.data, "base64").toString())
      .join("\n");
  assert.ok(html.includes('data-trusted-theme="studio"'));
  assert.ok(html.includes("A clear saved article."));
  if (engine === "hexo") assert.ok(html.includes("Approved script ran in worker"));
  else {
    assert.ok(html.includes("Trusted reference 1.0.0"));
    assert.ok(css.includes("--fixture-approved-theme"));
  }
  evidence.push({
    engine,
    theme: theme.id,
    version: theme.version,
    packageDigest: theme.package.digest,
    themeDigest: theme.sha256,
    files: artifact.files.length,
    bytes: artifact.bytes,
  });
}
console.log(JSON.stringify({ image, verified: evidence }, null, 2));
