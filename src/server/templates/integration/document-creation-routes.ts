import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { templateObject } from "../../../shared/templates/portable/validation.js";
import { DOCUMENT_TEMPLATE_INPUT_BYTES } from "../../../shared/templates/application.js";
import type { DocumentTemplateApplication } from "../application/document.js";
import type { FileDocumentNavigation } from "../../documents/files/navigation/service.js";
import { templateManagementProtection } from "./protect.js";

/** The application adapter joins two ports; neither source templates nor project storage acquires the other's persistence. */
export function documentTemplateCreationRoutes(
  templates: DocumentTemplateApplication,
  documents: Pick<FileDocumentNavigation, "createFromSource">,
  owner: (context: RouteContext) => string,
): Route[] {
  return [
    {
      path: "/api/project-documents/from-template",
      method: "POST",
      handler: templateManagementProtection(owner)(async (context, actor) => {
        const input = templateObject(await readJsonBody(context.req, DOCUMENT_TEMPLATE_INPUT_BYTES + 8192), [
            "id",
            "projectId",
            "treeVersion",
            "parentId",
            "title",
            "locale",
            "template",
            "values",
          ]),
          { template, values, ...creation } = input,
          source = templates.command({ template, values });
        respondJson(context.res, 201, await documents.createFromSource(actor, creation, source));
      }),
    },
  ];
}
