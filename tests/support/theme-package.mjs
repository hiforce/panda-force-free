import { createHash } from "node:crypto";

/** Deliberately executable fixtures prove both engines use package files rather than built-in CSS profiles. */
export function exampleThemePackage(version = "1.0.0") {
  const file = (path, value) => ({
    path,
    data: Buffer.from(value).toString("base64"),
    sha256: createHash("sha256").update(value).digest("hex"),
  });
  const label = {
    name: "Studio",
    description: "An isolated fixture theme.",
    labels: { "zh-CN": { name: "示例主题", description: "隔离构建的示例主题。" } },
  };
  return {
    schema: 1,
    manifest: {
      schema: 1,
      id: "example.studio",
      version,
      ...label,
      permissions: ["content:site-themes", "build:theme-code", "content:templates"],
      siteThemes: [
        { id: "journal", ...label, engine: "hexo", engineVersion: "8.1.1", root: "hexo" },
        {
          id: "reference",
          ...label,
          engine: "docusaurus",
          engineVersion: "3.10.2",
          root: "docusaurus",
          entry: "index.js",
        },
      ],
      channelTemplates: [
        {
          id: "paper",
          ...label,
          formats: ["html", "x-article"],
          style: { font: "Georgia,serif", color: "#222222", accent: "#884422", width: "720px", size: "17px" },
        },
      ],
    },
    files: [
      file(
        "hexo/layout/layout.ejs",
        '<!doctype html><html><head><title><%= config.title %></title></head><body data-trusted-theme="studio"><header>Trusted journal ' +
          version +
          "</header><main><%- body %></main><footer><%= studioMarker() %></footer></body></html>",
      ),
      file(
        "hexo/layout/index.ejs",
        "<% page.posts.each(post=>{ %><article><h1><%= post.title %></h1><%- post.content %></article><% }) %>",
      ),
      file("hexo/layout/post.ejs", "<article><h1><%= page.title %></h1><%- page.content %></article>"),
      file(
        "hexo/scripts/helpers.js",
        "hexo.extend.helper.register('studioMarker',()=> 'Approved script ran in worker');",
      ),
      file(
        "docusaurus/index.js",
        "const path=require('node:path');module.exports=()=>({name:'panda-fixture-theme',getClientModules(){return [path.join(__dirname,'custom.css')]},getThemePath(){return path.join(__dirname,'theme')}});",
      ),
      file(
        "docusaurus/custom.css",
        ":root{--fixture-approved-theme:#ab5317}body{border-top:7px solid var(--fixture-approved-theme)}",
      ),
      file(
        "docusaurus/theme/Root/index.js",
        "import React from 'react';export default function Root({children}){return React.createElement(React.Fragment,null,React.createElement('aside',{'data-trusted-theme':'studio'},'Trusted reference '+" +
          JSON.stringify(version) +
          "),children)}",
      ),
    ],
  };
}
