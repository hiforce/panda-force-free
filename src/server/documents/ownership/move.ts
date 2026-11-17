import { createHash } from "node:crypto";
import type { DocumentDetail } from "../../../shared/documents/contracts.js";
import type { DocumentOwnershipScope } from "../../../shared/documents/ownership.js";
import { DocumentError } from "../errors.js";
import type {
  DocumentOwnershipPlan,
  DocumentOwnershipInventory,
  DocumentOwnershipOriginals,
  DocumentOwnershipReceipt,
} from "./contracts.js";
import { assertOwnershipPlan } from "./plan.js";

export interface DocumentOwnershipSource<Snapshot> {
  readonly relationalOrigin?: object;
  inventory(snapshot: Snapshot): DocumentOwnershipInventory;
  assertCurrent(snapshot: Snapshot): Promise<void>;
  version(snapshot: Snapshot, documentId: string, revisionId: string): Promise<DocumentDetail>;
  image(snapshot: Snapshot, assetId: string): ReturnType<DocumentOwnershipOriginals["image"]>;
}
export interface DocumentOwnershipRemoval<Snapshot> {
  removed(plan: DocumentOwnershipPlan, inventory: DocumentOwnershipInventory): Promise<boolean>;
  remove(plan: DocumentOwnershipPlan, snapshot: Snapshot): Promise<void>;
  assertRemoved(plan: DocumentOwnershipPlan, inventory: DocumentOwnershipInventory): Promise<void>;
}
export interface DocumentOwnershipTarget {
  receipt(plan: DocumentOwnershipPlan, inventory: DocumentOwnershipInventory): Promise<DocumentOwnershipReceipt | null>;
  stage(
    plan: DocumentOwnershipPlan,
    inventory: DocumentOwnershipInventory,
    originals: DocumentOwnershipOriginals,
    assertCurrent: () => Promise<void>,
  ): Promise<unknown>;
  verify(
    plan: DocumentOwnershipPlan,
    inventory: DocumentOwnershipInventory,
    originals: DocumentOwnershipOriginals,
  ): Promise<void>;
  activate(
    plan: DocumentOwnershipPlan,
    inventory: DocumentOwnershipInventory,
    assertRemoved: () => Promise<void>,
    originals: DocumentOwnershipOriginals,
  ): Promise<DocumentOwnershipReceipt>;
}
/** A transfer advances one identity; each physical phase has a durable receipt and rechecks live authority. */
export class DocumentOwnershipMove<Snapshot> {
  constructor(
    private readonly source: DocumentOwnershipSource<Snapshot>,
    private readonly removal: DocumentOwnershipRemoval<Snapshot>,
    private readonly target: DocumentOwnershipTarget,
    private readonly authorize: (owner: string, scope: DocumentOwnershipScope) => Promise<void>,
    private readonly afterStep?: (step: "staged" | "removed" | "activated") => Promise<void>,
  ) {}
  async execute(input: DocumentOwnershipPlan, source: Snapshot) {
    const plan = structuredClone(input),
      snapshot = structuredClone(source),
      inventory = this.source.inventory(snapshot),
      actorHash = createHash("sha256").update(plan.owner).digest("hex");
    assertOwnershipPlan(plan, inventory);
    for (const scope of [plan.from, plan.to])
      if (scope.projectId === "personal" && scope.personalOwnerHash !== actorHash)
        throw new DocumentError("notFound", 404);
    const authorized = async () => {
      await this.authorize(plan.owner, plan.from);
      await this.authorize(plan.owner, plan.to);
    };
    await authorized();
    const complete = await this.target.receipt(plan, inventory);
    if (complete) {
      await authorized();
      return complete;
    }
    const originals = {
      relationalOrigin: this.source.relationalOrigin,
      version: (id: string, revision: string) => this.source.version(snapshot, id, revision),
      image: (id: string) => this.source.image(snapshot, id),
    };
    if (!(await this.removal.removed(plan, inventory))) {
      await this.target.stage(plan, inventory, originals, async () => {
        await authorized();
        await this.source.assertCurrent(snapshot);
      });
      await this.afterStep?.("staged");
      await authorized();
      await this.removal.remove(plan, snapshot);
      await this.afterStep?.("removed");
    } else await this.target.verify(plan, inventory, originals);
    await authorized();
    const receipt = await this.target.activate(
      plan,
      inventory,
      () => this.removal.assertRemoved(plan, inventory),
      originals,
    );
    await this.afterStep?.("activated");
    await authorized();
    return receipt;
  }
}
