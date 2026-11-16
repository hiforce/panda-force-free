import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { FilePackageContent } from "../../packages/content-store.js";
import { SearchError, SEARCH_LIMITS, type AnalyzerPackage } from "../../../shared/search/contracts.js";
import { analyzerPackage } from "../../../shared/search/validation.js";
import { createAnalyzer, analyzerDigest } from "./registry.js";
import { ENGLISH_ANALYZER } from "./english.js";
interface AnalyzerReview {
  packages: AnalyzerPackage[];
  origin: Record<string, unknown>;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class AnalyzerStore {
  private files: FilePackageContent<AnalyzerReview>;
  constructor(
    private db: Database,
    root: string,
  ) {
    this.files = new FilePackageContent<AnalyzerReview>(root, {
      maxBytes: 2 * 1024 * 1024,
      encode: async (v) => Buffer.from(JSON.stringify(v)),
      decode: async (b) => {
        const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
        if (
          !Array.isArray(v.packages) ||
          v.packages.length > SEARCH_LIMITS.analyzers ||
          !v.origin ||
          typeof v.origin !== "object"
        )
          throw new SearchError("invalidInput");
        return { packages: v.packages.map(analyzerPackage), origin: v.origin };
      },
      digest,
    });
  }
  async initialize() {
    if (!this.db.query("SELECT reference FROM search_analyzers WHERE reference=?").get("panda.english@1.0.0")) {
      const value = { packages: [analyzerPackage(ENGLISH_ANALYZER)], origin: { kind: "builtin" } };
      await this.files.put(value);
      this.db
        .query("INSERT INTO search_analyzers VALUES(?,?,?)")
        .run("panda.english@1.0.0", digest(value), JSON.stringify(value.packages[0]));
    }
  }
  list() {
    return this.db
      .query<{ reference: string; descriptor: string }, []>(
        "SELECT reference,descriptor FROM search_analyzers ORDER BY reference",
      )
      .all()
      .map((x) => ({ reference: x.reference, descriptor: analyzerPackage(JSON.parse(x.descriptor)) }));
  }
  async resolve(reference: string) {
    const row = this.db
      .query<{ digest: string }, [string]>("SELECT digest FROM search_analyzers WHERE reference=?")
      .get(reference);
    if (!row) throw new SearchError("configuration", 409);
    const bundle = await this.files.read(row.digest),
      p = bundle.packages.find((x) => x.id + "@" + x.version === reference);
    if (!p) throw new SearchError("configuration", 503);
    return createAnalyzer(p);
  }
  async review(owner: string, value: unknown, origin: Record<string, unknown>) {
    const list = Array.isArray(value) ? value : [value];
    if (!list.length || list.length > SEARCH_LIMITS.analyzers) throw new SearchError("limit");
    const packages = list.map(analyzerPackage);
    if (new Set(packages.map((p) => p.id + "@" + p.version)).size !== packages.length)
      throw new SearchError("invalidInput");
    const bundle = { packages, origin };
    await this.files.put(bundle);
    const hash = digest(bundle);
    this.db.query("INSERT OR IGNORE INTO search_analyzer_reviews VALUES(?,?,?)").run(owner, hash, Date.now());
    return { digest: hash, packages, origin };
  }
  async install(owner: string, hash: string) {
    if (
      !/^[a-f0-9]{64}$/.test(hash) ||
      !this.db.query("SELECT digest FROM search_analyzer_reviews WHERE owner=? AND digest=?").get(owner, hash)
    )
      throw new SearchError("notFound", 404);
    const bundle = await this.files.read(hash);
    this.db
      .transaction(() => {
        if (
          new Set([...this.list().map((p) => p.reference), ...bundle.packages.map((p) => p.id + "@" + p.version)])
            .size > SEARCH_LIMITS.analyzers
        )
          throw new SearchError("limit", 409);
        for (const p of bundle.packages) {
          const ref = p.id + "@" + p.version,
            old = this.db
              .query<{ descriptor: string }, [string]>("SELECT descriptor FROM search_analyzers WHERE reference=?")
              .get(ref);
          if (old && analyzerDigest(analyzerPackage(JSON.parse(old.descriptor))) !== analyzerDigest(p))
            throw new SearchError("conflict", 409);
          this.db.query("INSERT OR IGNORE INTO search_analyzers VALUES(?,?,?)").run(ref, hash, JSON.stringify(p));
        }
      })
      .immediate();
    return this.list();
  }
  async export(reference: string) {
    return (await this.resolve(reference)).descriptor;
  }
}
