import { organizationCli } from "../../src/server/project-memory/organization-tools.js";
import { extractMemoryClaims } from "../../src/server/project-memory/rules.js";
import type { ModelReviewPort } from "../../src/server/project-memory/model-review.js";
import type { HarnessMetadata } from "../../src/server/harness/ports.js";
import { save } from "../../src/server/harness/records.js";
import { memoryKey } from "../../src/server/project-memory/rules.js";
import type { MemoryConversation } from "../../src/server/project-memory/records.js";
import type { ProjectMemory } from "../../src/server/project-memory/service.js";
import type { HarnessMessage } from "../../src/shared/harness/contracts.js";

export const memoryFixturePolicy = {
  enabled: true,
  selection: { runtimeId: "fixture", model: "fixture", effort: "low" },
};
export const memoryFixtureOrganizer: ModelReviewPort = {
  async resolve(_owner, selection) {
    return selection;
  },
  async review() {
    throw Error("The retired memory reviewer cannot be used.");
  },
  async organize(_owner, _selection, context) {
    const proposals = new Map<string, Record<string, string>>();
    for (const { id, user } of context.sources) {
      for (const claim of extractMemoryClaims(user)) {
        const prior = context.existing.find(
          (entry) => entry.key === memoryKey(claim.key) && entry.scope === claim.scope,
        );
        const fields = { key: claim.key, scope: claim.scope, value: claim.value, quote: user.trim(), sourceId: id };
        proposals.set(
          claim.key + "/" + claim.scope,
          claim.replaces && prior?.version ? { ...fields, action: "replace" } : fields,
        );
      }
    }
    const cli = organizationCli({ ...context, job: "a".repeat(32) });
    await cli.submit(JSON.stringify({ entries: [...proposals.values()] }));
    return cli.result()!;
  },
};

export async function runDueMemory(store: HarnessMetadata, memory: ProjectMemory) {
  const jobs = await store.list("project-memory-organization");
  for (const due of jobs) {
    await store.transaction(async (tx) => {
      const prior = await tx.get(due.id);
      if (!prior || prior.revision !== due.revision || JSON.parse(prior.data).attempts) return;
      await tx.put({ ...prior, revision: prior.revision + 1, updatedAt: 0 }, prior.revision);
    });
  }
  for (const _unused of jobs) await memory.processPending();
}

export async function stageCompletedMemory(
  tx: Parameters<HarnessMetadata["transaction"]>[0] extends (value: infer Tx) => unknown ? Tx : never,
  memory: ProjectMemory,
  source: MemoryConversation,
  user: Pick<HarnessMessage, "id" | "seq" | "runId">,
  fromBytes = 0,
) {
  if (!user.runId) throw Error("fixture requires a run id");
  await save(tx, "run:" + user.runId, "run", source.owner, {
    owner: source.owner,
    conversationId: source.id,
    userMessageId: user.id,
    status: "complete",
  });
  const conversation = await memory.scope({ ...source, historyBytes: fromBytes });
  const boundary = conversation && (await memory.organizationBoundary(tx, conversation, user.seq));
  if (boundary) await memory.organizations.enqueue(tx, boundary, source.historyBytes, user.seq);
}
