import type { ProjectMetadataReservation } from "../../src/server/projects/workspaces/service.js";
import { ProjectWorkspaceService } from "../../src/server/projects/workspaces/service.js";
import type { ProjectCatalog } from "../../src/server/projects/catalog.js";
import type { MySQLProjectCatalog } from "../../src/server/projects/mysql-catalog.js";

const synchronous: ProjectMetadataReservation = () => undefined;
// @ts-expect-error Catalog transactions cannot accept asynchronous metadata reservations.
const asynchronous: ProjectMetadataReservation = async () => {};
// @ts-expect-error Reservation hooks return no result that could hide deferred work.
const deferred: ProjectMetadataReservation = () => ({ finish: Promise.resolve() });
void synchronous;
void asynchronous;
void deferred;
declare const sqlite: ProjectCatalog;
declare const mysql: MySQLProjectCatalog;
// @ts-expect-error SQLite reservation callbacks must not suspend a synchronous transaction.
new ProjectWorkspaceService(sqlite, "/owned-project-root", true, async () => {});
new ProjectWorkspaceService(mysql, "/owned-project-root", true, async () => {});
