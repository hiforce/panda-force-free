import { ProjectContentError } from "./errors.js";

export function projectContentId(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value))
    throw new ProjectContentError("invalidFile");
  return value;
}

const documentPrefix = "documents/",
  documentSuffix = ".panda.json";
export const projectDocumentFile = (id: string) => documentPrefix + projectContentId(id) + documentSuffix;
export const projectSpaceFile = (id: string) => "spaces/" + projectContentId(id) + documentSuffix;
export const projectKnowledgeFile = (id: string) => "knowledge/" + projectContentId(id) + documentSuffix;
export const projectKnowledgeMarkdown = (id: string) => "knowledge/" + projectContentId(id) + ".md";
export const projectCreationFile = (id: string) => "creations/" + projectContentId(id) + documentSuffix;
export const projectCreationHtml = (id: string) => "creation-sources/" + projectContentId(id) + ".html";
export function projectDocumentId(path: unknown): string | null {
  if (typeof path !== "string") throw new ProjectContentError("invalidFile");
  if (!path.startsWith(documentPrefix) || !path.endsWith(documentSuffix)) return null;
  return projectContentId(path.slice(documentPrefix.length, -documentSuffix.length));
}

/** Portable content and asset records may enter history; blob bytes and runtime state stay outside it. */
export function projectFilePath(value: string): string {
  if (["project.json", "tree.json", "languages.json", "import.json"].includes(value)) return value;
  const html = /^creation-sources\/([^/]+)\.html$/.exec(value);
  if (html) {
    projectContentId(html[1]);
    return value;
  }
  const readable = /^knowledge\/([^/]+)\.md$/.exec(value);
  if (readable) {
    projectContentId(readable[1]);
    return value;
  }
  const match =
    /^(documents|spaces|placements|asset-records|navigation-operations|knowledge|creations)\/([^/]+)\.panda\.json$/.exec(
      value,
    );
  if (!match) throw new ProjectContentError("invalidFile");
  projectContentId(match[2]);
  return value;
}
