import { createHash } from "node:crypto";
import type { RouteContext, Route } from "../http/router.js";
import { readJsonBody } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import { documentRouteProtection } from "../documents/protection.js";
import { DocumentError } from "../documents/errors.js";
import { documentIdentity } from "../documents/files/projects.js";
import { documentOperationUuid } from "../documents/files/commands.js";
import { richImageId, type RichTextNode } from "../../shared/documents/rich-body.js";
import { richDocumentFromMarkdown } from "../documents/rich-codec.js";
import type { createFileDocumentApplication } from "../documents/files/application.js";
import type { PersonalContent } from "./personal.js";

function targetOperation(id: string, project: string) {
  const hash = createHash("sha256")
    .update(id + ":" + project)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
/** Copies pinned source content and owned image bytes; target receipts make retries independent per project. */
export function personalCopyRoute(options: {
  personal: PersonalContent;
  projects: ReturnType<typeof createFileDocumentApplication>;
  owner(context: RouteContext): string;
}): Route {
  return {
    path: "/api/personal/copy",
    method: "POST",
    handler: documentRouteProtection(async (context) => {
      const input = await readJsonBody(context.req, 8192),
        actor = options.owner(context);
      const operation = documentOperationUuid(input.operationId),
        documentId = documentIdentity(input.documentId),
        revisionId = documentIdentity(input.revisionId);
      if (!Array.isArray(input.projects) || input.projects.length < 1 || input.projects.length > 20)
        throw new DocumentError("invalidInput");
      const targets = input.projects.map(documentIdentity);
      if (new Set(targets).size !== targets.length || targets.includes("personal"))
        throw new DocumentError("invalidInput");
      const { documents } = await options.personal.forOwner(actor);
      const source = await documents.queries.source("personal", documentId, revisionId);
      const body = source.revision.body ?? richDocumentFromMarkdown(source.revision.content);
      const images = new Set<string>();
      const visit = (node: RichTextNode) => {
        if (node.type === "image") images.add(richImageId(node.attrs?.src));
        node.content?.forEach(visit);
      };
      visit(body.document);
      const preparedImages = await Promise.all(
        [...images].map(async (id) => {
          const result = await documents.assets.content("personal", id);
          if (result.asset.documentId !== documentId) throw new DocumentError("notFound", 404);
          return { id, name: result.asset.name, bytes: result.bytes };
        }),
      );
      const results: { projectId: string; documentId?: string; state: "copied" | "failed" }[] = [];
      for (const projectId of targets) {
        try {
          const result = await options.projects.navigation.appendFromSource(
            actor,
            {
              id: targetOperation(operation, projectId),
              projectId,
              parentId: null,
              title: source.revision.title,
              locale: source.revision.locale,
            },
            {
              identity: JSON.stringify({ kind: "personal-copy", actor, documentId, revisionId }),
              prepare: async () => ({
                body,
                images: preparedImages,
                copiedFrom: { scope: "personal", documentId, revisionId },
              }),
            },
          );
          results.push({ projectId, documentId: result.operation.documentId, state: "copied" });
        } catch {
          results.push({ projectId, state: "failed" });
        }
      }
      respondJson(context.res, 200, { results });
    }),
  };
}
