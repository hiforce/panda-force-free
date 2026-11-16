import { createFileDocumentApplication } from "../../documents/files/application.js";
import type { ContentAccessAction } from "../contracts.js";

type Application = ReturnType<typeof createFileDocumentApplication>;
/** Cached application adapters retain no authority; each operation rechecks membership under the project's file lease. */
export function scopedFileDocuments(
  options: Omit<
    Parameters<typeof createFileDocumentApplication>[0],
    "requireProject" | "principal" | "authorizeUnderLease"
  >,
  authorize: (owner: string, project: string, action: ContentAccessAction) => void | Promise<void>,
) {
  const cache = new Map<string, Application>();
  return (owner: string, action: ContentAccessAction = "read") => {
    const key = owner + ":" + action;
    let application = cache.get(key);
    if (!application) {
      application = createFileDocumentApplication({
        ...options,
        principal: () => owner,
        requireProject: (project) => authorize(owner, project, action),
        authorizeUnderLease: (project) => authorize(owner, project, action),
      });
      cache.set(key, application);
    } else {
      cache.delete(key);
      cache.set(key, application);
    }
    while (cache.size > 128) cache.delete(cache.keys().next().value!);
    return application;
  };
}
