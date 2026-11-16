import type { MetadataStore } from "../metadata-ports.js";
import type { KnowledgeContent } from "./contracts.js";
export interface KnowledgeAccessScope {
  owner: string;
  project: string;
}
export interface KnowledgeAccessStore {
  next(after?: KnowledgeAccessScope): KnowledgeAccessScope | null;
  revoke(scope: KnowledgeAccessScope, now: number): void;
}
/** Unavailability is not evidence that a human revoked a grant. */
export function isKnowledgeAccessDenied(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && error.code === "notFound" && "status" in error && error.status === 404
  );
}
/** Scan only unfinished scopes and enabled policies; foreground authorization remains independent of this bounded audit. */
export class KnowledgeAccessAudit {
  private after: KnowledgeAccessScope | undefined;
  constructor(
    private store: MetadataStore<KnowledgeAccessStore>,
    private content: Pick<KnowledgeContent, "authorize">,
    private runtime: {
      scopes(): KnowledgeAccessScope[];
      interruptScope(owner: string, project: string): void;
    },
    private report: (error: unknown) => void,
    private now = Date.now,
  ) {}
  async tick() {
    const seen = new Set<string>();
    const check = async (scope: KnowledgeAccessScope) => {
      const key = JSON.stringify([scope.owner, scope.project]);
      if (seen.has(key)) return;
      seen.add(key);
      try {
        await this.content.authorize(scope.owner, scope.project);
      } catch (error) {
        if (isKnowledgeAccessDenied(error)) await this.store.revoke(scope, this.now());
        else this.report(error);
        this.runtime.interruptScope(scope.owner, scope.project);
      }
    };
    for (const scope of this.runtime.scopes()) await check(scope);
    const scanned = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const scope = (await this.store.next(this.after)) ?? (await this.store.next());
      if (!scope) break;
      this.after = scope;
      const key = JSON.stringify([scope.owner, scope.project]);
      if (scanned.has(key)) break;
      scanned.add(key);
      await check(scope);
    }
  }
}
