import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import type { Route, RouteContext } from "../../http/router.js";
import { PACKAGE_LIMITS, PluginPackageError } from "../../../shared/plugins/contracts.js";
import { packageRecord } from "../../../shared/plugins/validation.js";
import type { PluginApproval, PluginRegistryServicePort } from "../service.js";
import type { PluginExportRef } from "../../../shared/plugins/exports.js";
import { pluginRouteProtection } from "./protect.js";
export function pluginRoutes(service: PluginRegistryServicePort, owner: (context: RouteContext) => string): Route[] {
  const protect = pluginRouteProtection(owner);
  return [
    {
      path: "/api/document-packages",
      method: "GET",
      handler: protect(async ({ res }) => respondJson(res, 200, await service.snapshot())),
    },
    {
      path: "/api/document-packages/export",
      method: "GET",
      handler: protect(async ({ res, url }) => {
        const value = await service.exportPackage(url.searchParams.get("id")!, url.searchParams.get("version")!);
        respondJson(res, 200, value.package);
      }),
    },
    {
      path: "/api/document-packages/audit",
      method: "GET",
      handler: protect(async ({ res, url }) =>
        respondJson(res, 200, {
          events: await service.audit(
            url.searchParams.has("after") ? Number(url.searchParams.get("after")) : undefined,
          ),
        }),
      ),
    },
    {
      path: "/api/document-packages/review",
      method: "POST",
      handler: protect(async ({ req, res }) => {
        respondJson(res, 200, await service.review(await readJsonBody(req, PACKAGE_LIMITS.jsonBytes)));
      }),
    },
    {
      path: "/api/document-packages/review-selection",
      method: "POST",
      handler: protect(async ({ req, res }) => {
        const input = packageRecord(await readJsonBody(req, PACKAGE_LIMITS.jsonBytes + 4096), ["package", "selected"]);
        if (!Array.isArray(input.selected)) throw new PluginPackageError("invalidPackage");
        respondJson(res, 200, await service.review(input.package, input.selected));
      }),
    },
    {
      path: "/api/document-packages/install",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = packageRecord(await readJsonBody(req, PACKAGE_LIMITS.jsonBytes + 4096), ["package", "approval"]),
          approval = packageRecord(input.approval, [
            "digest",
            "expectedRevision",
            "permissions",
            "selected",
            "reviewHash",
          ]);
        const installed = await service.install(input.package, approval as unknown as PluginApproval, actor);
        respondJson(res, 201, { installed, ...(await service.snapshot()) });
      }),
    },
    {
      path: "/api/document-packages/state",
      method: "PUT",
      handler: protect(async ({ req, res }, actor) => {
        const input = packageRecord(await readJsonBody(req, 4096), ["id", "version", "expectedRevision", "enabled"]);
        await service.setEnabled(
          input.id as string,
          input.version as string,
          input.enabled as boolean,
          input.expectedRevision as number,
          actor,
        );
        respondJson(res, 200, await service.snapshot());
      }),
    },
    {
      path: "/api/document-packages/exports/state",
      method: "PUT",
      handler: protect(async ({ req, res }, actor) => {
        const input = packageRecord(await readJsonBody(req, 4096), [
          "id",
          "version",
          "expectedRevision",
          "export",
          "enabled",
        ]);
        await service.setExportEnabled(
          input.id as string,
          input.version as string,
          input.export as PluginExportRef,
          input.enabled as boolean,
          input.expectedRevision as number,
          actor,
        );
        respondJson(res, 200, await service.snapshot());
      }),
    },
    {
      path: "/api/document-packages/exports/activate",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = packageRecord(await readJsonBody(req, 4096), ["id", "version", "expectedRevision", "export"]);
        await service.activateExport(
          input.id as string,
          input.version as string,
          input.export as PluginExportRef,
          input.expectedRevision as number,
          actor,
        );
        respondJson(res, 200, await service.snapshot());
      }),
    },
    {
      path: "/api/document-packages/activate",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = packageRecord(await readJsonBody(req, 4096), ["id", "version", "expectedRevision"]);
        await service.activate(input.id as string, input.version as string, input.expectedRevision as number, actor);
        respondJson(res, 200, await service.snapshot());
      }),
    },
  ];
}
