import { createHash } from "node:crypto";
import { GadgetError } from "../../shared/gadget/contracts.js";
import { defaultGadgetLayout, validateGadgetLayout } from "../../shared/gadget/layout.js";
import type { GadgetRepository } from "./ports.js";
import type { GadgetRegistry } from "./registry.js";
import type { GadgetLayout, GadgetManifest } from "../../shared/gadget/contracts.js";
export class GadgetWorkspaceService {
  constructor(
    readonly registry: GadgetRegistry,
    readonly store: GadgetRepository,
    private readonly upgrade: (layout: GadgetLayout, catalog: readonly GadgetManifest[]) => GadgetLayout = (layout) =>
      layout,
  ) {}
  async layout(owner: string) {
    const saved = await this.store.read(owner);
    return this.upgrade(
      this.registry.migrate(saved.revision ? saved : defaultGadgetLayout(this.registry.catalog())),
      this.registry.catalog(),
    );
  }
  async save(owner: string, input: unknown, expected: string | undefined) {
    if (
      !input ||
      typeof input !== "object" ||
      !("operationId" in input) ||
      !("layout" in input) ||
      typeof input.operationId !== "string" ||
      !/^[-a-zA-Z0-9]{8,100}$/.test(input.operationId)
    )
      throw new GadgetError("invalidInput");
    const request = createHash("sha256").update(JSON.stringify({ input, expected })).digest("hex");
    const replay = await this.store.replay(owner, input.operationId, request);
    if (replay) return replay;
    const prior = await this.layout(owner);
    if (expected !== `"${prior.revision}"`) throw new GadgetError("conflict", 409);
    const layout = validateGadgetLayout(input.layout, this.registry.catalog(), prior);
    if (layout.revision !== prior.revision) throw new GadgetError("conflict", 409);
    return this.store.save(owner, input.operationId, request, prior.revision, layout);
  }
}
