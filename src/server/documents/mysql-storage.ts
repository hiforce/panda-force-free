import type { SQL } from "bun";
import { MySQLDocumentSession } from "./mysql-session.js";
import { MySQLSpaceRepository } from "./mysql-space-repository.js";
import { MySQLDocumentRepository } from "./mysql-document-repository.js";
import { MySQLDocumentAssetRepository } from "./mysql-asset-repository.js";
import { MySQLDocumentFolderRepository } from "./mysql-folder-repository.js";
import { MySQLProjectLibraryRepository } from "./mysql-library-repository.js";
import { MySQLSourceProfileRepository } from "./source-profile/mysql-repository.js";
import { MySQLDocumentPlacementRepository } from "./placements/mysql-repository.js";
import { MySQLDocumentNavigationRepository } from "./navigation/mysql-repository.js";
import { MySQLDocumentIngestionRepository } from "./ingestion/mysql-repository.js";
/** Inject the returned native async repositories; callers retain ownership of the SQL pool and file adapters. */
export function createMySQLDocumentStorage(pool: SQL) {
  const session = new MySQLDocumentSession(pool),
    spaces = new MySQLSpaceRepository(session),
    documents = new MySQLDocumentRepository(session),
    assets = new MySQLDocumentAssetRepository(session);
  return {
    session,
    spaces,
    documents,
    assets,
    folders: new MySQLDocumentFolderRepository(session),
    library: new MySQLProjectLibraryRepository(session, spaces),
    profiles: new MySQLSourceProfileRepository(session, spaces),
    placements: new MySQLDocumentPlacementRepository(session),
    navigation: new MySQLDocumentNavigationRepository(session),
    ingestion: new MySQLDocumentIngestionRepository(session, documents, assets),
  };
}
