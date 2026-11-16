import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeTaskInput, KnowledgeRecord } from "../../src/shared/knowledge/tasks.js";
import { knowledgeTaskFiles } from "../../src/server/knowledge/integration/task-files.js";
import { knowledgeContext, knowledgeInput } from "../../src/server/knowledge/tasks/input.js";
import { validateKnowledgeEvidence } from "../../src/server/knowledge/evidence.js";
import { knowledgeRecordVersion } from "../../src/server/knowledge/tasks/record.js";
import {
  knowledgePrevious,
  previousFileDigest,
  previousState,
  previousTextChunk,
} from "../../src/server/knowledge/tasks/previous.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-knowledge-files-"));
  roots.push(root);
  return { root, files: knowledgeTaskFiles(root) };
}
function input(): KnowledgeTaskInput {
  return {
    schema: 1,
    scope: { project: "p1", ids: ["doc1"] },
    purpose: "Explain durable storage",
    sourceCommit: "commit-1",
    sources: [
      {
        id: "doc1",
        version: "revision-1",
        kind: "asset",
        title: "Durable storage",
        text: "Flush acknowledged writes to stable storage.",
        sections: [{ id: "durability", start: 0, end: 43 }],
      },
    ],
    profile: { id: "default", engineId: "codex", model: "model-1", activeTimeoutMs: 180000 },
    target: { id: "knowledge-1", expectedVersion: null },
  };
}
const draft = {
  schema: 1 as const,
  title: "Durability",
  summary: "How acknowledged writes survive restarts.",
  claims: [
    {
      id: "c1",
      kind: "source" as const,
      text: "Acknowledged writes should reach stable storage.",
      evidence: [{ sourceId: "doc1", version: "revision-1", quote: "stable storage", section: "durability" }],
    },
  ],
  uncertainties: [],
};

test("immutable contexts survive restart and reject altered bytes or a different codec", async () => {
  const { root, files } = await fixture();
  const digest = await files.putInput(input());
  expect(await knowledgeTaskFiles(root).input(digest)).toEqual(input());
  await expect(files.draft(digest)).rejects.toThrow();
  const path = join(root, "inputs", digest + ".json");
  const value = JSON.parse(await readFile(path, "utf8"));
  value.sources[0].text = "Changed source";
  await writeFile(path, JSON.stringify(value));
  await expect(files.input(digest)).rejects.toThrow();
  await expect(files.putInput(input())).rejects.toThrow();
});

test("snapshots reject duplicate, unselected and oversized multilingual context", () => {
  const value = input();
  expect(() => knowledgeInput({ ...value, sources: [{ ...value.sources[0], id: "foreign-doc" }] })).toThrow();
  expect(() => knowledgeInput({ ...value, scope: { project: "p1", ids: ["doc1", "doc1"] } })).toThrow();
  expect(() => knowledgeInput({ ...value, sources: [{ ...value.sources[0], text: "语".repeat(150000) }] })).toThrow();
  expect(() => knowledgeInput({ ...value, profile: { ...value.profile, command: "shell" } })).toThrow();
});

test("answers are separate quoted evidence, not replacements for an original saved asset", async () => {
  const { files } = await fixture();
  const dialogue = {
    questions: [{ id: "q1", question: "Which storage?", options: ["Local", "Network"] }],
    answers: [{ questionId: "q1", answer: "Use local NVMe." }],
  };
  const digest = await files.putDialogue(dialogue),
    sources = knowledgeContext(input(), await files.dialogue(digest));
  expect(sources[0]).toEqual(input().sources[0]);
  expect(sources[1]?.kind).toBe("user-input");
  expect(sources[1]?.id).toBe("user-q1");
  expect(() =>
    validateKnowledgeEvidence(
      {
        ...draft,
        claims: [
          {
            ...draft.claims[0],
            evidence: [{ sourceId: "user-q1", version: sources[1]!.version, quote: "local NVMe" }],
          },
        ],
      },
      sources,
    ),
  ).toThrow("invalidEvidence");
  await expect(
    files.putDialogue({ ...dialogue, answers: [...dialogue.answers, ...dialogue.answers] }),
  ).rejects.toThrow();
});

test("approved records preserve derived citation offsets and reject modified claim content", async () => {
  const { root, files } = await fixture(),
    sources = input().sources;
  const record: KnowledgeRecord = {
    schema: 1,
    id: "knowledge-1",
    version: "",
    previousVersion: null,
    taskId: "task-1",
    sourceCommit: "commit-1",
    sources: sources.map(({ text: _text, sections: _sections, ...metadata }) => metadata),
    draft: validateKnowledgeEvidence(draft, sources),
    approvedAt: 1000,
  };
  record.version = knowledgeRecordVersion(record);
  const digest = await files.putOutput(record),
    read = await knowledgeTaskFiles(root).output(digest);
  expect(read.draft.claims[0]?.evidence[0]?.start).toBe(sources[0]!.text.indexOf("stable storage"));
  expect(read.version).toBe(record.version);
  await expect(
    files.putOutput({ ...record, draft: { ...record.draft, summary: "Changed after approval" } }),
  ).rejects.toThrow();
  expect(record.draft.claims[0]?.evidence[0]?.kind).toBe("asset");
});

test("prior readable bytes survive restart, stay distinct from input codecs and reject changed digests", async () => {
  const { root, files } = await fixture(),
    markdown = "Manual text <script>data only</script>\n" + "\u0000".repeat(100000),
    prior = knowledgePrevious({
      schema: 1,
      id: "knowledge-1",
      json: null,
      markdown,
      files: { json: null, markdown: previousFileDigest(markdown) },
    }),
    digest = await files.putPrevious(prior);
  expect(await knowledgeTaskFiles(root).previous(digest)).toEqual(prior);
  await expect(files.input(digest)).rejects.toThrow();
  expect(() => knowledgePrevious({ ...prior, markdown: markdown + "changed" })).toThrow();
  expect(() => knowledgePrevious({ ...prior, files: { ...prior.files, json: "a".repeat(64) } })).toThrow();
  expect(() => knowledgePrevious({ ...prior, markdown: "a".repeat(1024 * 1024 + 1) })).toThrow();
  const path = join(root, "previous", digest + ".json");
  await writeFile(path, JSON.stringify({ ...prior, markdown: "changed" }));
  await expect(files.previous(digest)).rejects.toThrow();
  expect(previousState(prior)).not.toBe(previousState({ ...prior, files: { json: "a".repeat(64), markdown: null } }));
});

test("comparison pages preserve Unicode boundaries and bound escaped control-character transport", () => {
  const text = "x".repeat(65535) + "🦊" + "\u0000".repeat(70000),
    chunks: string[] = [];
  let offset = 0;
  for (;;) {
    const page = previousTextChunk(text, offset);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(400000);
    expect(page.start).toBe(offset);
    chunks.push(page.markdown);
    if (page.next === null) break;
    offset = page.next;
  }
  expect(chunks.join("")).toBe(text);
  expect(chunks[0]!.length).toBe(65535);
  for (const offset of [-1, 1.5, Infinity, text.length + 1, 65536])
    expect(() => previousTextChunk(text, offset)).toThrow();
});
