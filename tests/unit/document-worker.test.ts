import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffold } from "../../src/document-worker/scaffold.js";
import { collectArtifact } from "../../src/document-worker/artifact.js";
import { buildInput } from "../../src/shared/builds/validation.js";

const source = {
  protocol: 1,
  engine: "hexo",
  preset: "reader",
  site: { title: "A 'quoted' handbook", url: "https://docs.example.test", basePath: "/guide/", locale: "zh-CN" },
  documents: [
    {
      id: "one",
      path: "a/intro.md",
      title: "Start",
      content: "---\ntitle: Untrusted metadata\npermalink: /other/\n---\n\nFirst article.",
    },
    { id: "two", path: "b/intro.md", title: "Second", content: "Second article." },
  ],
  assets: [],
};

test("Hexo scaffolds preserve separate document routes and replace imported executable configuration with a trusted preset", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-scaffold-"));
  try {
    const command = await scaffold(buildInput(source), join(root, "site"), "/missing-toolchain");
    expect(command.command).toBe("/missing-toolchain/node_modules/hexo-cli/bin/hexo");
    expect(command.args).toEqual(["generate"]);
    const posts = await Promise.all(
      (await readdir(join(root, "site/source/_posts"))).map((file) =>
        readFile(join(root, "site/source/_posts", file), "utf8"),
      ),
    );
    const first = posts.find((post) => post.includes("First article."))!;
    const second = posts.find((post) => post.includes("Second article."))!;
    expect(posts).toHaveLength(2);
    expect(first).toContain('permalink: "posts/a/intro/"');
    expect(second).toContain('permalink: "posts/b/intro/"');
    expect(first).not.toContain("/other/");
    expect(first).toContain("First article.");
    expect(await readFile(join(root, "site/_config.yml"), "utf8")).toContain('root: "/guide/"');
    const installed = JSON.parse(await readFile(join(root, "site/package.json"), "utf8"));
    expect(installed.dependencies["hexo-renderer-stylus"]).toBe("3.0.1");
    expect(installed.dependencies["hexo-generator-archive"]).toBe("2.0.0");
    expect(installed.dependencies["hexo-generator-tag"]).toBe("2.0.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Docusaurus config quotes values as data and only enables the trusted handbook preset", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-scaffold-"));
  try {
    const title = "'; require('node:fs').rmSync('/data'); //";
    const command = await scaffold(
      buildInput({ ...source, engine: "docusaurus", preset: "handbook", site: { ...source.site, title } }),
      join(root, "site"),
    );
    const text = await readFile(join(root, "site/docusaurus.config.js"), "utf8");
    const config = JSON.parse(text.slice("module.exports=".length, -1));
    expect(config.title).toBe(title);
    expect(config.presets[0][0]).toBe("@docusaurus/preset-classic");
    expect(config.plugins).toBeUndefined();
    expect(command.args[0]).toBe("build");
    expect(command.args).not.toContain("deploy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated artifacts reject symlinks and include only regular hashed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-artifact-"));
  try {
    await writeFile(join(root, "index.html"), "<h1>Hello</h1>");
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets/site.css"), "body{}");
    const artifact = await collectArtifact(root);
    expect(artifact.files.map((file) => file.path)).toEqual(["assets/site.css", "index.html"]);
    expect(artifact.bytes).toBe(20);
    await symlink("/etc/hostname", join(root, "assets/external"));
    await expect(collectArtifact(root)).rejects.toThrow("unsafeOutput");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker semantic helpers escape figure arguments and use only owned static image paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-tags-"));
  try {
    await scaffold(buildInput(source), join(root, "site"));
    const script = await readFile(join(root, "site/scripts/panda-semantic-tags.js"), "utf8");
    const tags = new Map<string, (args: string[], content: string) => string>();
    const hexo = {
      render: { renderSync: ({ text }: { text: string }) => `<p>${text}</p>` },
      extend: {
        tag: { register: (name: string, fn: (args: string[], content: string) => string) => tags.set(name, fn) },
        helper: { get: () => (path: string) => "/guide" + path },
      },
    };
    new Function("hexo", script)(hexo);
    const figure = tags.get("figure")!;
    expect(figure(["/assets/cover.png", '<script>"Bad"</script>', "12", "9"], "Caption")).toBe(
      '<figure><img src="/guide/assets/cover.png" alt="&lt;script&gt;&quot;Bad&quot;&lt;/script&gt;" width="12" height="9" loading="lazy"><figcaption><p>Caption</p></figcaption></figure>',
    );
    for (const url of [
      "https://example.com/image.png",
      "//external.test/image.png",
      '/assets/"broken.png',
      "/assets/image.png onerror=bad",
    ])
      expect(() => figure([url, "alt"], "")).toThrow("unsupportedFigureImage");
    expect(tags.get("abstract")!(["<unsafe>"], "Body")).toContain("&lt;unsafe&gt;");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
