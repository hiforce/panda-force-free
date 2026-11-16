import type { DocumentAsset } from "../../../shared/documents/contracts.js";
import type { SiteEdition, SiteSourceProfile } from "../../../shared/sites/profile.js";
import type { SourceResourceFile } from "../../documents/source-profile/resources.js";

/** Build projection consumes authorized immutable image data, independent from its storage backend. */
export interface BuildDocumentAssets {
  metadata(id: string): DocumentAsset | Promise<DocumentAsset>;
  content(id: string): Promise<{ asset: DocumentAsset; bytes: Buffer }>;
}
export interface BuildDocumentProfile {
  profile: SiteSourceProfile;
  edition: SiteEdition;
  files: SourceResourceFile[];
}
