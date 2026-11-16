import { createHash } from "node:crypto";
import type { BuildInput } from "../../shared/builds/contracts.js";
import { body } from "./source.js";

/** Public front matter is JSON-encoded as YAML scalars, preserving routes and dates without re-parsing source YAML. */
export function hexoDocument(doc: BuildInput["documents"][number]) {
  const meta: NonNullable<BuildInput["documents"][number]["metadata"]> = { ...doc.metadata, title: doc.title };
  const parts = doc.path.split("/"),
    fromEdition = /^source(?:-[a-z-]+)?$/i.test(parts[0]!);
  const source = fromEdition ? parts.slice(1).join("/") : doc.path;
  const post =
    source.startsWith("_posts/") ||
    source.startsWith("_drafts/") ||
    (!fromEdition && (!meta.layout || meta.layout === "post"));
  let path: string;
  if (post) {
    meta.slug ||= source.split("/").at(-1)!.replace(/\.md$/, "");
    meta.permalink ||= `posts/${meta.slug}/`;
    meta.date ||= "2020-01-01 00:00:00";
    const draft = source.startsWith("_drafts/") || meta.published === false || meta.draft === true;
    path = `source/${draft ? "_drafts" : "_posts"}/${createHash("sha256").update(doc.path).digest("hex")}.md`;
  } else path = "source/" + source;
  return {
    path,
    content:
      "---\n" +
      Object.entries(meta)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join("\n") +
      "\n---\n\n" +
      body(doc.content),
  };
}
