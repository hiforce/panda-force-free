import { expect, test } from "bun:test";
import { knowledgeDraftHtml } from "../../src/client/knowledge/draft-view.js";
import type { Translate } from "../../src/shared/i18n/messages.js";
import type { KnowledgeDraft } from "../../src/shared/knowledge/contracts.js";

test("approved reading preserves evidence distinctions and escapes source labels, quotes and uncertainty", () => {
  const draft: KnowledgeDraft = {
    schema: 1,
    title: "<h1>Unsafe</h1>",
    summary: "<script>Unsafe</script>",
    claims: ["source", "inference", "user"].map((kind) => ({
      id: kind,
      kind: kind as "source" | "inference" | "user",
      text: "Claim <img src=x onerror=evil()>",
      evidence: [
        {
          sourceId: "original",
          version: "saved-version",
          kind: "asset",
          digest: "digest",
          start: 0,
          end: 10,
          quote: "<svg onload=evil()>",
        },
      ],
    })),
    uncertainties: ["Still <uncertain>"],
  };
  const t = ((id: string) => id) as Translate,
    sources = [{ id: "original", title: "Source <title>" }],
    html = knowledgeDraftHtml(draft, t, { title: false, sources, compactEvidence: true }),
    review = knowledgeDraftHtml(draft, t, { sources });
  expect(review).toContain("saved-version · 0–10");
  expect(html).not.toContain("saved-version");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<svg ");
  expect(html).not.toContain("<img ");
  expect(html).not.toContain("<h1>");
  expect(html).toContain("Source &lt;title&gt;");
  expect(html).toContain("Still &lt;uncertain&gt;");
  for (const kind of ["claimSource", "claimInference", "claimUser"]) expect(html).toContain("knowledge." + kind);
});
