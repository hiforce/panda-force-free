import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { projectFileApiFixture } from "./project-file-api-fixture.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { FileOriginalQueries } from "../../src/server/content-sources/reader.js";
import { extractCreativeText } from "../../src/server/creative/assets/projection.js";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { knowledgeTaskFiles } from "../../src/server/knowledge/integration/task-files.js";
import { KnowledgeTasks } from "../../src/server/knowledge/tasks/service.js";
import { KnowledgeGenerationPolicies } from "../../src/server/knowledge/storage/generation-policies.js";
import { KnowledgeGenerationQueue } from "../../src/server/knowledge/storage/generation-queue.js";
import { KnowledgeGenerationAdmission } from "../../src/server/knowledge/storage/generation-admission.js";
import { KnowledgeGenerationSettings } from "../../src/server/knowledge/generation/service.js";
import { KnowledgeGenerationDiscovery } from "../../src/server/knowledge/generation/discovery.js";
import { KnowledgeGenerationSubmission } from "../../src/server/knowledge/generation/submission.js";
import { fileKnowledgeGenerationSource } from "../../src/server/knowledge/integration/generation-content.js";
import { defaultGenerationPolicy } from "../../src/shared/knowledge/generation.js";
import type { KnowledgeGenerationChange } from "../../src/shared/knowledge/generation.js";

/** Real file/Git and shared SQLite admission, without a timer, engine, reviewer or business callback. */
export async function nativeGenerationFixture() {
  const f = await projectFileApiFixture(),
    app = f.application(),
    path = join(f.root, "generation-test-" + randomUUID() + ".sqlite"),
    files = knowledgeTaskFiles(path + "-tasks");
  let db = openKnowledgeDatabase(path),
    time = 1000000,
    parsed = 0,
    captureHook = async () => {};
  const originals = new FileOriginalQueries(app.projectContent, f.assetRoot, async (...args) => {
      parsed++;
      return extractCreativeText(...args);
    }),
    content = new FileDocumentKnowledgeContent(app.projectContent, app.projectContent, originals),
    capture = content.capture.bind(content),
    source = fileKnowledgeGenerationSource(
      async () => app.projectContent,
      undefined,
      async () => originals,
    ),
    errors: unknown[] = [];
  content.capture = async (...args) => {
    const result = await capture(...args);
    await captureHook();
    return result;
  };
  const execution = { wake() {}, interrupt() {} },
    now = () => time;
  function components() {
    const ledger = knowledgeTaskLedger(db),
      policies = new KnowledgeGenerationPolicies(db, ledger),
      queue = new KnowledgeGenerationQueue(db, ledger),
      admission = new KnowledgeGenerationAdmission(db),
      tasks = new KnowledgeTasks(
        ledger,
        files,
        content,
        async () => ({ id: "native-rule", engineId: "codex", model: "synthetic", activeTimeoutMs: 1000 }),
        { async reconcile() {} },
        execution,
        now,
      ),
      discovery = new KnowledgeGenerationDiscovery(
        policies,
        queue,
        source,
        execution,
        (error) => errors.push(error),
        now,
      ),
      submission = new KnowledgeGenerationSubmission(policies, queue, admission, source, tasks, () => true, now),
      settings = new KnowledgeGenerationSettings(policies, source, content, execution, now);
    return { ledger, policies, queue, admission, tasks, discovery, submission, settings };
  }
  let c = components();
  return {
    ...f,
    app,
    source,
    originals,
    files,
    content,
    errors,
    get c() {
      return c;
    },
    get db() {
      return db;
    },
    get parsed() {
      return parsed;
    },
    now,
    advance(ms = 6000) {
      time += ms;
    },
    hook(value: () => Promise<void>) {
      captureHook = value;
    },
    async configure(change: Partial<KnowledgeGenerationChange> = {}) {
      const policy = await c.settings.policy("alice", "project-1");
      return c.settings.configure("alice", "project-1", {
        ...defaultGenerationPolicy(),
        ...policy,
        ...change,
        backfill: change.backfill ?? false,
      });
    },
    async scan() {
      await c.discovery.scan(new AbortController().signal);
    },
    async submit() {
      await c.submission.run(new AbortController().signal);
    },
    restart() {
      db.close();
      db = openKnowledgeDatabase(path);
      c = components();
    },
    async close() {
      db.close();
      await f.close();
    },
  };
}
