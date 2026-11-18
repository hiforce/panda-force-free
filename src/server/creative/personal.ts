import type { OriginalStorageFeature } from "../object-storage/feature.js";
import { createHash } from "node:crypto";
import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createFileDocumentApplication } from "../documents/files/application.js";
import type { Route, RouteContext } from "../http/router.js";
import { createRouter } from "../http/router.js";
import { respondJson } from "../http/respond.js";
import { documentRouteProtection } from "../documents/protection.js";
import { DocumentError } from "../documents/errors.js";
import { PERSONAL_CONTENT_SCOPE } from "../../shared/creative/scope.js";
import { DocumentFileProjects, type DocumentProjectReads } from "../documents/files/projects.js";
import { FileSavedQueries } from "../documents/files/saved-queries.js";
import { FileCreativeAssetReader } from "./assets/reader.js";
import { FileOriginalQueries } from "../content-sources/reader.js";

type Documents = ReturnType<typeof createFileDocumentApplication>;
type Creation = { routes: Route[]; start(): void; close(): Promise<void> };
export interface PersonalContentOptions {
  originalStorage?: Pick<OriginalStorageFeature, "objects" | "purges">;
  contentRoot: string;
  assetRoot: string;
  stateRoot: string;
  owner(context: RouteContext): string;
  authorize?(owner: string): void | Promise<void>;
  creation?(root: string, owner: string, documents: Documents): Creation;
  documentRoutes?(documents: Documents, owner: string): Route[];
  changed?(project: string, owner: string): void;
}
/** Each authenticated principal owns a separate filesystem and service lifetime. IDs supplied by the browser never select owners. */
export class PersonalContent {
  private readonly readers = new Map<string, DocumentProjectReads>();
  private readonly owners = new Map<
    string,
    Promise<{ documents: Documents; creation?: Creation; dispatch: ReturnType<typeof createRouter> }>
  >();
  constructor(private readonly options: PersonalContentOptions) {}
  private roots(owner: string) {
    const key = createHash("sha256").update(owner).digest("hex");
    return [this.options.contentRoot, this.options.assetRoot, this.options.stateRoot].map((root) =>
      join(root, "personal", key),
    );
  }
  /** File reads must not initialize personal roots or start an unrelated creation queue. */
  readProjects(owner: string) {
    let projects = this.readers.get(owner);
    if (!projects) {
      const root = this.roots(owner)[0]!;
      const present = async () => {
        try {
          const info = await lstat(root);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new DocumentError("unavailable", 503);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return false;
        }
      };
      const files = new DocumentFileProjects(root, async (id) => {
        if (id !== PERSONAL_CONTENT_SCOPE) throw new DocumentError("notFound", 404);
        await present();
      });
      projects = {
        authorize: (id) => files.authorize(id),
        ifPresent: async (id, work) => {
          await files.authorize(id);
          if (!(await present())) return null;
          return files.ifPresent(id, work);
        },
      };
      this.readers.set(owner, projects);
      while (this.readers.size > 256) this.readers.delete(this.readers.keys().next().value!);
    }
    return projects;
  }
  readQueries(owner: string) {
    return new FileSavedQueries(this.readProjects(owner));
  }
  private authorizedReads(owner: string): DocumentProjectReads {
    const projects = this.readProjects(owner),
      authorize = async (id: string) => {
        await this.options.authorize?.(owner);
        await projects.authorize(id);
      };
    return {
      authorize,
      ifPresent: async (id, work) => {
        await authorize(id);
        const result = await projects.ifPresent(id, work);
        await authorize(id);
        return result;
      },
    };
  }
  readCreations(owner: string) {
    return new FileCreativeAssetReader(
      this.authorizedReads(owner),
      this.roots(owner)[1]!,
      undefined,
      this.options.originalStorage?.objects,
    );
  }
  readOriginals(owner: string) {
    return new FileOriginalQueries(
      this.authorizedReads(owner),
      this.roots(owner)[1]!,
      undefined,
      this.options.originalStorage?.objects,
    );
  }
  async forOwner(owner: string) {
    await this.options.authorize?.(owner);
    let opening = this.owners.get(owner);
    if (!opening) {
      opening = this.open(owner);
      this.owners.set(owner, opening);
    }
    try {
      return await opening;
    } catch (error) {
      if (this.owners.get(owner) === opening) this.owners.delete(owner);
      throw error;
    }
  }
  private async open(owner: string) {
    const roots = this.roots(owner);
    for (const path of roots) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new DocumentError("unavailable", 503);
    }
    const authorize = async (id: string) => {
      if (id !== PERSONAL_CONTENT_SCOPE) throw new DocumentError("notFound", 404);
      await this.options.authorize?.(owner);
    };
    const documents = createFileDocumentApplication({
      originalStorage: this.options.originalStorage,
      root: roots[0]!,
      assetRoot: roots[1]!,
      principal: () => owner,
      changed: (project) => this.options.changed?.(project, owner),
      requireProject: authorize,
      authorizeUnderLease: authorize,
    });
    const creation = this.options.creation?.(roots[2]!, owner, documents);
    const dispatch = createRouter([
      {
        path: "/api/project-documents/capabilities",
        method: "GET",
        handler: ({ res }) =>
          respondJson(res, 200, { storage: "files", preview: true, publication: false, websiteConfiguration: false }),
      },
      ...documents.routes,
      ...(this.options.documentRoutes?.(documents, owner) ?? []),
      ...(creation?.routes ?? []),
    ]);
    creation?.start();
    return { documents, creation, dispatch };
  }
  routes(): Route[] {
    return [
      {
        path: (path) => path.startsWith("/api/personal/"),
        handler: documentRouteProtection(async (context) => {
          const personal = await this.forOwner(this.options.owner(context));
          const url = new URL(context.url);
          url.pathname = url.pathname.replace("/api/personal/", "/api/");
          if (!(await personal.dispatch({ ...context, url }))) throw new DocumentError("notFound", 404);
        }),
      },
    ];
  }
  async close() {
    for (const value of this.owners.values()) await (await value).creation?.close();
  }
}
