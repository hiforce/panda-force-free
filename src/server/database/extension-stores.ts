import type { SQL } from "bun";
import { MySQLPluginRegistry } from "../plugins/storage/mysql.js";
import { MySQLTemplateLibrary } from "../plugins/storage/mysql-library.js";
import { MySQLSiteSamples } from "../plugins/storage/mysql-site-samples.js";
import { MySQLPortableTemplates } from "../templates/storage/mysql.js";
import { MySQLPortableDrafts } from "../templates/storage/mysql-drafts.js";
import { MySQLPortableImages } from "../templates/storage/mysql-images.js";
import { MySQLNativeThemes } from "../templates/storage/mysql-native-registry.js";
import { MySQLNativeSlides } from "../slides/storage/mysql.js";
import { MySQLSourceStages } from "../packages/staging/mysql.js";
import type { SourceStageCapacity } from "../packages/staging/records.js";
import { MySQLNativeSamples } from "../builds/native/mysql.js";
import { MySQLSiteBuildRepository } from "../builds/mysql.js";
import { MySQLVariantRepository } from "../publishing/mysql-variant-repository.js";
import { MySQLTemplatePreviews } from "../template-previews/mysql-repository.js";
import type { MySQLLedgerTransaction } from "../packages/mysql-ledger.js";
/** Explicit assembly ports; selecting these never opens or mirrors a SQLite ledger. */
export function createMySQLExtensionStores(sql: SQL, options: { documentTransaction?: MySQLLedgerTransaction } = {}) {
  return {
    plugins: new MySQLPluginRegistry(sql),
    templateLibrary: new MySQLTemplateLibrary(sql),
    siteSamples: new MySQLSiteSamples(sql),
    portableTemplates: new MySQLPortableTemplates(sql),
    portableDrafts: new MySQLPortableDrafts(sql),
    portableImages: new MySQLPortableImages(sql),
    nativeThemes: new MySQLNativeThemes(sql),
    nativeSlides: new MySQLNativeSlides(sql),
    sourceStages: (namespace: "package" | "native_theme" | "native_slides", capacity?: SourceStageCapacity) =>
      new MySQLSourceStages(
        sql,
        capacity ??
          (namespace === "package"
            ? undefined
            : {
                ownerBytes: 512 * 1024 * 1024,
                globalBytes: 2 * 1024 * 1024 * 1024,
                ownerItems: 1024,
                globalItems: 2048,
              }),
        namespace,
      ),
    nativeSamples: new MySQLNativeSamples(sql),
    builds: new MySQLSiteBuildRepository(sql, options.documentTransaction),
    publishing: new MySQLVariantRepository(sql, options.documentTransaction),
    templatePreviews: new MySQLTemplatePreviews(sql),
  };
}

export type MySQLExtensionStores = ReturnType<typeof createMySQLExtensionStores>;
/** Each feature receives its complete owned ledger set; bodies keep their existing application paths. */
export function mySQLExtensionPersistence(stores: MySQLExtensionStores) {
  return {
    plugins: { registry: stores.plugins, library: stores.templateLibrary, samples: stores.siteSamples },
    portable: { registry: stores.portableTemplates, drafts: stores.portableDrafts, images: stores.portableImages },
    native: { registry: stores.nativeThemes, stages: stores.sourceStages("native_theme") },
    nativeSlides: { registry: stores.nativeSlides, stages: stores.sourceStages("native_slides") },
    packageSources: { store: stores.sourceStages("package") },
    siteBuilds: { jobs: stores.builds, transaction: <T>(work: () => Promise<T>) => stores.builds.transaction(work) },
    nativeSamples: { jobs: stores.nativeSamples },
    publishing: stores.publishing,
    templatePreviews: { jobs: stores.templatePreviews },
  };
}
