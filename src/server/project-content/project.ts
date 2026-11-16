import type { OwnedProjectDirectory } from "./owned-directory.js";
import { ProjectContentCoordinator } from "./coordinator.js";
import { ProjectDocumentFiles } from "./document-store.js";
import { ProjectSpaceFiles } from "./space-store.js";
import { ProjectNavigationFiles } from "./navigation-store.js";
import { ProjectAssetMetadata } from "./asset-records.js";
import { ProjectNavigationOperationFiles } from "./navigation-operation-store.js";
import { ProjectPlacementFiles } from "./placement-store.js";
import { ProjectDocumentDrafts } from "./drafts/store.js";
import { ProjectDocumentCheckpoints } from "./drafts/checkpoints.js";
import { ProjectLanguageFiles } from "./language-store.js";
import { ProjectDocumentSourceEdits } from "./source-edits.js";

/** Application composition creates one owner per authorized project, not a new queue per request or repository. */
export class ProjectContentProject {
  readonly coordinator: ProjectContentCoordinator;
  readonly documents: ProjectDocumentFiles;
  readonly spaces: ProjectSpaceFiles;
  readonly navigation: ProjectNavigationFiles;
  readonly assets: ProjectAssetMetadata;
  readonly languages: ProjectLanguageFiles;
  readonly placements: ProjectPlacementFiles;
  readonly drafts: ProjectDocumentDrafts;
  readonly checkpoints: ProjectDocumentCheckpoints;
  readonly sourceEdits: ProjectDocumentSourceEdits;
  readonly navigationOperations: ProjectNavigationOperationFiles;
  constructor(
    readonly owned: OwnedProjectDirectory,
    authorize?: () => void | Promise<void>,
  ) {
    this.coordinator = new ProjectContentCoordinator(owned, authorize);
    this.documents = new ProjectDocumentFiles(owned, this.coordinator);
    this.spaces = new ProjectSpaceFiles(owned, this.coordinator);
    this.navigation = new ProjectNavigationFiles(owned, this.coordinator);
    this.assets = new ProjectAssetMetadata(owned, this.coordinator);
    this.languages = new ProjectLanguageFiles(owned, this.coordinator);
    this.placements = new ProjectPlacementFiles(owned, this.coordinator);
    this.drafts = new ProjectDocumentDrafts(owned, this.coordinator);
    this.checkpoints = new ProjectDocumentCheckpoints(owned, this.coordinator, this.documents, this.drafts);
    this.sourceEdits = new ProjectDocumentSourceEdits(owned, this.coordinator, this.documents, this.drafts);
    this.navigationOperations = new ProjectNavigationOperationFiles(owned, this.coordinator);
  }
}
