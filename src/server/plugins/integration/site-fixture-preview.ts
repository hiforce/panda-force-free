import type { MetadataStore } from "../../../shared/async-value.js";
import type { TemplateDefinition, TemplateFixture, TemplateFixturePreview } from "../../../shared/plugins/library.js";
import { canonicalPackageJson, packageSha256 } from "../../../shared/plugins/validation.js";
import type { SiteSampleStore } from "../ports.js";
import type { SiteBuildArtifacts } from "../../builds/artifacts.js";
import { SiteBuildPreview } from "../../builds/preview.js";
import { SiteBuildError } from "../../builds/errors.js";
import { definitionSiteSample, siteSampleKey } from "./site-sample-input.js";

/** A completed sample is reused by exact execution identity; reading it neither starts work nor grants code access. */
export function siteFixturePreview(jobs: MetadataStore<SiteSampleStore>, artifacts: SiteBuildArtifacts) {
  const preview = new SiteBuildPreview(
    {
      async requireArtifact(id) {
        const job = await jobs.get(id);
        if (job.phase !== "completed" || !job.artifactAvailable) throw new SiteBuildError("artifactUnavailable", 404);
        return job;
      },
    },
    artifacts,
  );
  return async (definition: TemplateDefinition, fixture: TemplateFixture): Promise<TemplateFixturePreview> => {
    const frozen = await definitionSiteSample(definition, fixture.id),
      key = await siteSampleKey(frozen.input),
      job = await jobs.latest(key);
    const pending: TemplateFixturePreview = {
      fixtureId: fixture.id,
      state: "requiresBuild",
      actualDigest: null,
      expectedDigest: fixture.expectedDigest,
      issues: [{ code: job?.error || (job ? "siteSamplePending" : "sitePreviewRequiresBuild"), severity: "warning" }],
      html: "",
      text: "",
      posts: [],
      ...(job
        ? { siteBuild: { id: job.id, phase: job.phase, error: job.error, artifactAvailable: job.artifactAvailable } }
        : {}),
    };
    if (!job || job.phase !== "completed" || !job.artifactAvailable) return pending;
    let output;
    try {
      output = await preview.manifest(job.id);
    } catch {
      return { ...pending, issues: [{ code: "sampleArtifactUnavailable", severity: "warning" }] };
    }
    const pages = output
      .filter((file) => file.path.endsWith(".html"))
      .map((file) => file.path)
      .sort();
    if (!pages.length) return { ...pending, issues: [{ code: "sampleArtifactUnavailable", severity: "warning" }] };
    const actualDigest = await packageSha256(
      canonicalPackageJson({
        key,
        files: output
          .map((file) => ({ path: file.path, sha256: file.sha256 }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      }),
    );
    const html = await preview.file(job.id, pages.includes("index.html") ? "index.html" : pages[0]!);
    return {
      fixtureId: fixture.id,
      state:
        fixture.expectedDigest === null
          ? "unreviewed"
          : fixture.expectedDigest === actualDigest
            ? "passed"
            : "mismatch",
      actualDigest,
      expectedDigest: fixture.expectedDigest,
      issues: [],
      html: html.bytes.toString("utf8"),
      text: "",
      posts: [],
      sitePages: pages,
      siteBuild: { id: job.id, phase: job.phase, error: null, artifactAvailable: true },
      siteEvidence: {
        runId: job.id,
        inputHash: job.inputHash,
        runnerVersion: job.context.runnerVersion,
        engineVersion: job.context.engineVersion,
        image: job.image,
      },
    };
  };
}
