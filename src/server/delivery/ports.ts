import type { BuildArtifact } from "../../shared/builds/contracts.js";
import type { PublicationConnection } from "../../shared/connections/contracts.js";
import type { PublicationReceipt, SitePublicationPlan } from "../../shared/delivery/contracts.js";

/** Resolve file-backed ownership before a transaction; recheck mutable policy synchronously inside its fence. */
export interface PublicationAccess {
  assertCurrent(): void;
  assertDestination(path: string): void;
}
export interface PublicationSources {
  authorize(spaceId: string, projectId?: string): Promise<PublicationAccess> | PublicationAccess;
  capture(
    buildId: string,
    ownerId?: string,
  ): Promise<{
    projectId: string;
    sourceProjectId?: string;
    spaceId: string;
    build: SitePublicationPlan["build"];
    artifact: BuildArtifact;
  }>;
}
export interface PublicationConnections {
  owned(ownerId: string, id: string): { connection: PublicationConnection; targetPath: string };
  assertReady(ownerId: string, id: string): void;
}
/** The gate fences local side effects synchronously in the same transaction as job ownership. */
export interface PublicationGate {
  fence: number;
  run<T>(step: "staging" | "activating", operation: () => T): T | Promise<T>;
  remote<T>(step: "staging" | "activating", name: string, operation: () => Promise<T>): Promise<T>;
}
export interface SiteDeliveryAdapter {
  recovery?: "inspect-only";
  reconcile(plan: SitePublicationPlan, artifact: BuildArtifact): Promise<PublicationReceipt | null>;
  recover?(plan: SitePublicationPlan, artifact: BuildArtifact, gate: PublicationGate): Promise<PublicationReceipt>;
  deliver(plan: SitePublicationPlan, artifact: BuildArtifact, gate: PublicationGate): Promise<PublicationReceipt>;
}
