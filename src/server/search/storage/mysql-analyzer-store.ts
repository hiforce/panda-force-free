import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { createHash } from "node:crypto";
import { FilePackageContent } from "../../packages/content-store.js";
import { SearchError, SEARCH_LIMITS, type AnalyzerPackage } from "../../../shared/search/contracts.js";
import { analyzerPackage } from "../../../shared/search/validation.js";
import { createAnalyzer, analyzerDigest } from "../analyzers/registry.js";
import { ENGLISH_ANALYZER } from "../analyzers/english.js";
interface AnalyzerReview {
  packages: AnalyzerPackage[];
  origin: Record<string, unknown>;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class MySQLAnalyzerStore {
  private files: FilePackageContent<AnalyzerReview>;
  constructor(
    private db: MySQLMetadataContext,
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
    return await this.db.atomic(async () => {
      if (
        !(await this.db.one("SELECT reference FROM panda_force_search_analyzers WHERE reference=?", [
          "panda.english@1.0.0",
        ]))
      ) {
        const value = { packages: [analyzerPackage(ENGLISH_ANALYZER)], origin: { kind: "builtin" } };
        await this.files.put(value);
        await this.db.execute("INSERT INTO panda_force_search_analyzers VALUES(?,?,?)", [
          "panda.english@1.0.0",
          digest(value),
          JSON.stringify(value.packages[0]),
        ]);
      }
    });
  }
  async list() {
    return await this.db.atomic(async () => {
      return (
        await this.db.all<{
          reference: string;
          descriptor: string;
        }>("SELECT reference,descriptor FROM panda_force_search_analyzers ORDER BY reference", [])
      ).map((x) => ({ reference: x.reference, descriptor: analyzerPackage(JSON.parse(x.descriptor)) }));
    });
  }
  async resolve(reference: string) {
    return await this.db.atomic(async () => {
      const row = await this.db.one<{
        digest: string;
      }>("SELECT digest FROM panda_force_search_analyzers WHERE reference=?", [reference]);
      if (!row) throw new SearchError("configuration", 409);
      const bundle = await this.files.read(row.digest),
        p = bundle.packages.find((x) => x.id + "@" + x.version === reference);
      if (!p) throw new SearchError("configuration", 503);
      return createAnalyzer(p);
    });
  }
  async review(owner: string, value: unknown, origin: Record<string, unknown>) {
    return await this.db.atomic(async () => {
      const list = Array.isArray(value) ? value : [value];
      if (!list.length || list.length > SEARCH_LIMITS.analyzers) throw new SearchError("limit");
      const packages = list.map(analyzerPackage);
      if (new Set(packages.map((p) => p.id + "@" + p.version)).size !== packages.length)
        throw new SearchError("invalidInput");
      const bundle = { packages, origin };
      await this.files.put(bundle);
      const hash = digest(bundle);
      await this.db.execute("INSERT IGNORE INTO panda_force_search_analyzer_reviews VALUES(?,?,?)", [
        owner,
        hash,
        Date.now(),
      ]);
      return { digest: hash, packages, origin };
    });
  }
  async install(owner: string, hash: string) {
    return await this.db.atomic(async () => {
      if (
        !/^[a-f0-9]{64}$/.test(hash) ||
        !(await this.db.one("SELECT digest FROM panda_force_search_analyzer_reviews WHERE owner=? AND digest=?", [
          owner,
          hash,
        ]))
      )
        throw new SearchError("notFound", 404);
      const bundle = await this.files.read(hash);
      await this.db.atomic(async () => {
        if (
          new Set([
            ...(await this.list()).map((p) => p.reference),
            ...bundle.packages.map((p) => p.id + "@" + p.version),
          ]).size > SEARCH_LIMITS.analyzers
        )
          throw new SearchError("limit", 409);
        for (const p of bundle.packages) {
          const ref = p.id + "@" + p.version,
            old = await this.db.one<{
              descriptor: string;
            }>("SELECT descriptor FROM panda_force_search_analyzers WHERE reference=?", [ref]);
          if (old && analyzerDigest(analyzerPackage(JSON.parse(old.descriptor))) !== analyzerDigest(p))
            throw new SearchError("conflict", 409);
          await this.db.execute("INSERT IGNORE INTO panda_force_search_analyzers VALUES(?,?,?)", [
            ref,
            hash,
            JSON.stringify(p),
          ]);
        }
      });
      return await this.list();
    });
  }
  async export(reference: string) {
    return await this.db.atomic(async () => {
      return (await this.resolve(reference)).descriptor;
    });
  }
}
