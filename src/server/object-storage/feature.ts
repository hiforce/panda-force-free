import { isAbsolute, join } from "node:path";
import type { RouteContext } from "../http/router.js";
import { CreativeAssetPurges } from "../creative/assets/purge.js";
import { OriginalStorageConfiguration } from "./configuration.js";
import { PrivateStorageFiles } from "./private-files.js";
import { OriginalObjectStorage } from "./originals.js";
import { originalStorageRoutes } from "./routes.js";
import { StorageRegistration } from "./registration.js";
import { GoogleStorageConsent } from "./google-consent.js";
import { storageRegistrationRoutes } from "./registration-routes.js";
import { storageBrowserRoutes } from "./browser-routes.js";

/** Original storage has its own private configuration and keys; static CDN configuration is never consulted. */
export function createOriginalStorageFeature(options: {
  stateRoot: string;
  contentRoot: string;
  privateParent?: string;
  administrator(context: RouteContext): boolean;
  authenticationConfigured(): boolean;
}) {
  const parent = options.privateParent || options.stateRoot;
  if (!isAbsolute(parent)) throw new Error("Original storage requires an absolute private parent directory");
  const files = new PrivateStorageFiles(join(parent, "original-storage")),
    configuration = new OriginalStorageConfiguration(files, (id): ReturnType<StorageRegistration["objectTarget"]> =>
      storage.objectTarget(id),
    ),
    storage = new StorageRegistration(files, configuration),
    google = new GoogleStorageConsent(storage),
    objects = new OriginalObjectStorage(configuration, options.authenticationConfigured),
    purges = new CreativeAssetPurges(objects, [options.contentRoot]);
  return {
    configuration,
    objects,
    purges,
    routes: [
      ...originalStorageRoutes({ ...options, configuration }),
      ...storageRegistrationRoutes({ ...options, storage, google }),
      ...storageBrowserRoutes({ ...options, storage }),
    ],
    start: () => purges.start(),
    close: () => purges.close(),
  };
}
export type OriginalStorageFeature = ReturnType<typeof createOriginalStorageFeature>;
