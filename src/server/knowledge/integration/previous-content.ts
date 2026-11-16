import type { ProjectContentView } from "../../project-content/read-view.js";
import { projectKnowledgeFile, projectKnowledgeMarkdown } from "../../project-content/paths.js";
import { knowledgePrevious, previousFileDigest } from "../tasks/previous.js";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";

/** Reads verify actual saved bytes, including otherwise untracked file collisions, before a target can be replaced. */
export async function capturePreviousKnowledge(view: ProjectContentView, id: string) {
  const read = async (path: string) => {
      if (view.version(path))
        await view.inspect(path, async (file) => {
          if (file.size > KNOWLEDGE_LIMITS.previousFileBytes) throw new KnowledgeTaskError("budget");
        });
      const bytes = await view.read(path);
      return bytes === null ? null : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    },
    json = await read(projectKnowledgeFile(id)),
    markdown = await read(projectKnowledgeMarkdown(id));
  return json === null && markdown === null
    ? null
    : knowledgePrevious({
        schema: 1,
        id,
        json,
        markdown,
        files: {
          json: json === null ? null : previousFileDigest(json),
          markdown: markdown === null ? null : previousFileDigest(markdown),
        },
      });
}
