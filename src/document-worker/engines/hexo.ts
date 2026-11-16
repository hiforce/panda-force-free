import { join } from "node:path";
import { createHash } from "node:crypto";
import type { BuildInput } from "../../shared/builds/contracts.js";
import type { EngineWorkspace } from "./workspace.js";
import { siteThemeCss } from "../theme.js";
import { semanticHexoTags } from "../semantic-tags.js";
import { body } from "./source.js";
import { hexoDocument } from "./hexo-document.js";
import { themeDependencies } from "../dependencies.js";
import { HEXO_RUNTIME_DEPENDENCIES } from "../../shared/builds/toolchain.js";
import { BUILD_ENGINES } from "../../shared/builds/engines.js";
const readerCss = `:root{font-family:system-ui,-apple-system,sans-serif;color:#202431;background:#fff;font-size:16px;line-height:1.8}*{box-sizing:border-box}body{margin:0}header,main,footer{max-width:880px;margin:auto;padding:28px}header{border-bottom:1px solid #e7e9ef;font-weight:650}header a{color:inherit;text-decoration:none}h1{font-size:clamp(28px,5vw,40px);line-height:1.25;letter-spacing:-.035em}h2{line-height:1.4}article{padding:24px 0;border-bottom:1px solid #e7e9ef}a{color:#4c50c6}img{max-width:100%;height:auto;border-radius:10px}pre{overflow:auto;background:#f6f7fa;padding:20px;border-radius:10px;font-size:13px}code{font-family:ui-monospace,monospace}blockquote{margin:24px 0;padding:4px 20px;border-left:3px solid #7478dc;color:#62677a}table{border-collapse:collapse;width:100%}td,th{padding:10px;border-bottom:1px solid #e7e9ef}footer{color:#737889;font-size:13px}@media(max-width:600px){header,main,footer{padding:20px}}`;

export async function prepareHexo(input: BuildInput, workspace: EngineWorkspace) {
  const { root, toolchain, put, installed } = workspace;
  if (!installed) await put("scripts/panda-semantic-tags.js", semanticHexoTags);
  await put(
    "package.json",
    JSON.stringify({
      name: "panda-document-build",
      private: true,
      hexo: { version: BUILD_ENGINES.hexo },
      dependencies: {
        ...HEXO_RUNTIME_DEPENDENCIES,
        ...(workspace.dependencies ?? themeDependencies(input)),
      },
    }),
  );
  await put(
    "_config.yml",
    Object.entries({
      title: input.site.title,
      url: input.site.url,
      root: input.site.basePath,
      permalink: "posts/:title/",
      theme: installed ? "panda-installed" : "panda-reader",
      source_dir: "source",
      public_dir: "public",
      language: input.site.locale,
      timezone: "UTC",
      ...input.project?.config,
    })
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n") + "\n",
  );
  if (!installed) {
    await put(
      "themes/panda-reader/layout/layout.ejs",
      '<!doctype html><html lang="<%= config.language %>"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title><%= page.title || config.title %></title><style>' +
        readerCss +
        siteThemeCss(input) +
        '</style></head><body><header><a href="<%= url_for("/") %>"><%= config.title %></a></header><main><%- body %></main><footer>Published with PandaForce</footer></body></html>',
    );
    await put(
      "themes/panda-reader/layout/index.ejs",
      '<h1><%= config.title %></h1><% page.posts.each(post => { %><article><h2><a href="<%= url_for(post.path) %>"><%= post.title %></a></h2><%- post.excerpt || post.content %></article><% }) %>',
    );
    await put("themes/panda-reader/layout/post.ejs", "<h1><%= page.title %></h1><%- page.content %>");
  }
  for (const document of input.documents) {
    if (input.project) {
      const projected = hexoDocument(document);
      await put(projected.path, projected.content);
      continue;
    }
    await put(
      `source/_posts/${createHash("sha256").update(document.path).digest("hex")}.md`,
      `---\ntitle: ${JSON.stringify(document.title)}\npermalink: ${JSON.stringify("posts/" + document.path.slice(0, -3) + "/")}\ndate: 2020-01-01 00:00:00\n---\n\n${body(document.content)}`,
    );
  }
  return {
    command: join(toolchain, "node_modules/hexo-cli/bin/hexo"),
    args: ["generate"],
    output: join(root, "public"),
  };
}
