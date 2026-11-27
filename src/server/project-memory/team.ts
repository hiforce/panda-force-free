import { HarnessError } from "../../shared/harness/contracts.js";
import type { MemoryEntry, MemoryTeamPreview, MemoryTeamPublication } from "../../shared/project-memory/contracts.js";
import type { HarnessMetadata, HarnessMetadataTransaction, HarnessRecord } from "../harness/ports.js";
import { decode, save } from "../harness/records.js";
import { digest } from "./records.js";

type Reader = Pick<HarnessMetadataTransaction, "get" | "list">;
export type TeamProof = { id: string; generation: number; merge?: string };
export type TeamAssertion = { key: string; scope: string; value: string };
type Grant = {
  owner: string;
  project: string;
  entryId: string;
  key: string;
  scope: string;
  proofs: TeamProof[];
  previewToken: string;
};
type TeamOrigin = TeamAssertion & { proofs: TeamProof[] };
type TeamSelection =
  | { publisher: string }
  | { matches: (key: string) => boolean }
  | { teamIds: ReadonlySet<string>; privateIds?: ReadonlySet<string> };

const activeKind = "project-memory-team-grant";
const cancelledKind = "project-memory-team-revoked";
const bucket = (project: string) => `pmt:${digest(project)}`;
const grantKey = (owner: string, project: string, id: string) => `memory-team:${digest([owner, project, id])}`;
const maxGrants = 256;

export class ProjectTeamMemory {
  constructor(
    private readonly metadata: HarnessMetadata,
    private readonly previewOrigin: (
      owner: string,
      project: string,
      entry: string,
      reader: Reader,
    ) => Promise<TeamOrigin | null>,
    private readonly currentOrigin: (
      owner: string,
      project: string,
      entry: string,
      proofs: TeamProof[],
      reader: Reader,
    ) => Promise<TeamAssertion | null>,
  ) {}

  private async previewAt(
    owner: string,
    project: string,
    entryId: string,
    prior: HarnessRecord | null,
    reader: Reader,
  ) {
    const origin = await this.previewOrigin(owner, project, entryId, reader);
    if (!origin) throw new HarnessError("notFound", 404);
    const token = digest([owner, project, entryId, prior?.revision ?? 0, origin]);
    return { ...origin, token };
  }

  preview(owner: string, project: string, entryId: string): Promise<MemoryTeamPreview> {
    return this.metadata.transaction(async (tx) => {
      const { proofs: _proofs, ...preview } = await this.previewAt(
        owner,
        project,
        entryId,
        await tx.get(grantKey(owner, project, entryId)),
        tx,
      );
      return { entryId, ...preview };
    });
  }

  publish(owner: string, project: string, entryId: string, token: string) {
    return this.metadata.transaction(async (tx) => {
      const id = grantKey(owner, project, entryId);
      const prior = await tx.get(id);
      const previous = decode<Grant>(prior);
      if (prior?.kind === activeKind && previous?.previewToken === token) {
        if (!(await this.currentOrigin(owner, project, entryId, previous.proofs, tx)))
          throw new HarnessError("conflict", 409);
        return { entryId, key: previous.key, scope: previous.scope, revision: prior.revision, active: true };
      }
      const preview = await this.previewAt(owner, project, entryId, prior, tx);
      if (preview.token !== token) throw new HarnessError("conflict", 409);
      if (prior?.kind === activeKind && previous && digest(previous.proofs) === digest(preview.proofs))
        return { entryId, key: previous.key, scope: previous.scope, revision: prior.revision, active: true };
      if (
        prior?.kind !== activeKind &&
        (await tx.list(activeKind, bucket(project), { limit: maxGrants })).length >= maxGrants
      )
        throw new HarnessError("conflict", 409);
      const revision = await save(tx, id, activeKind, bucket(project), {
        owner,
        project,
        entryId,
        key: preview.key,
        scope: preview.scope,
        proofs: preview.proofs,
        previewToken: token,
      } satisfies Grant);
      return { entryId, key: preview.key, scope: preview.scope, revision, active: true };
    });
  }

  withdraw(owner: string, project: string, entryId: string, revision: number) {
    return this.metadata.transaction(async (tx) => {
      const id = grantKey(owner, project, entryId);
      const row = await tx.get(id);
      if (!row) throw new HarnessError("notFound", 404);
      if (row.kind === cancelledKind && row.revision === revision + 1)
        return { entryId, revision: row.revision, active: false };
      if (row.kind !== activeKind || row.revision !== revision) throw new HarnessError("conflict", 409);
      const next = await save(tx, id, cancelledKind, bucket(project), { owner, project, entryId });
      return { entryId, revision: next, active: false };
    });
  }

  async catalog(project: string, reader: Reader, selection?: TeamSelection) {
    const rows = await reader.list(activeKind, bucket(project), { limit: maxGrants });
    const groups = new Map<string, Array<{ assertion: TeamAssertion; grant: string; revision: number }>>();
    const publications: MemoryTeamPublication[] = [];
    for (const row of rows) {
      const grant = decode<Grant>(row)!;
      if (grant.project !== project || (selection && "matches" in selection && !selection.matches(grant.key))) continue;
      const id = digest(["project-team", project, grant.entryId]);
      // Candidate labels identify what to check. Only the current source can provide the value or enter a result.
      if (
        selection &&
        "teamIds" in selection &&
        !selection.teamIds.has(id) &&
        !selection.privateIds?.has(grant.entryId)
      )
        continue;
      const assertion = await this.currentOrigin(grant.owner, project, grant.entryId, grant.proofs, reader);
      if (selection && "publisher" in selection && grant.owner === selection.publisher)
        publications.push({
          entryId: grant.entryId,
          key: grant.key,
          scope: grant.scope,
          revision: row.revision,
          active: !!assertion,
        });
      if (!assertion) continue;
      const item = { assertion, grant: row.id, revision: row.revision };
      const group = groups.get(id);
      if (group) group.push(item);
      else groups.set(id, [item]);
    }
    const entries: MemoryEntry[] = [...groups].map(([id, items]) => {
      const { key, scope, value } = items[0]!.assertion;
      const agreed = items.every((item) => item.assertion.value === value);
      return {
        id,
        key,
        scope,
        value: agreed ? value : null,
        state: agreed ? "active" : "conflict",
        version: agreed ? digest([id, value, items.map(({ grant, revision }) => [grant, revision]).sort()]) : null,
        sources: [],
        team: true,
      };
    });
    entries.sort((left, right) => left.key.localeCompare(right.key) || left.scope.localeCompare(right.scope));
    return { entries, publications };
  }
}
