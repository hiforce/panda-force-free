import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createPublicationConnections } from "../../src/server/connections/integration/feature.js";
import { SftpSites } from "../../src/server/remote-files/site.js";
import { SftpSiteDelivery } from "../../src/server/delivery/adapters/sftp-site.js";
import { PublicationRepository } from "../../src/server/delivery/repository.js";
import { PublicationService } from "../../src/server/delivery/service.js";
import { PublicationWorker } from "../../src/server/delivery/worker.js";
import { digest } from "../../src/server/delivery/validation.js";
import { remoteFilesFixture } from "./remote-files-fixture.js";

export async function sftpPublicationFixture(directory = "/website", storage: "legacy" | "files" = "legacy") {
  const remote = remoteFilesFixture(),
    db = new Database(join(remote.root, "state.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const projectId = randomUUID(),
    spaceId = randomUUID(),
    owner = "owner";
  const sourceProjectId = storage === "files" ? projectId : undefined;
  const sites = new SftpSites({ connect: async () => remote.files });
  const feature = createPublicationConnections({
    db,
    stateRoot: join(remote.root, "state"),
    sourceRoots: () => [],
    requireProject: (id) => {
      if (id !== projectId) throw new Error("Missing project");
    },
    env: {},
    remoteSites: sites,
  });
  const input = {
    id: randomUUID(),
    projectId,
    name: "Disposable SFTP",
    connector: "sftp-site" as const,
    host: "example.test",
    port: 22,
    username: "publisher",
    hostKey: "SHA256:" + Buffer.alloc(32, 1).toString("base64").replace(/=$/, ""),
    directory,
    publicUrl: "https://example.com/",
  };
  const created = await feature.connections.create(owner, input);
  const connection = await feature.credentials.write(owner, created.id, {
    version: 1,
    credential: { method: "password", password: "disposable-fixture-password" },
  });
  const content = "<h1>Frozen publication</h1>",
    bytes = Buffer.from(content);
  const artifact = {
    protocol: 1 as const,
    bytes: bytes.length,
    files: [{ path: "index.html", data: bytes.toString("base64"), sha256: digest(bytes) }],
  };
  const build = {
    id: randomUUID(),
    site: { title: "Fixture", url: "https://example.com", basePath: "/", locale: "en" },
    engine: "hexo" as const,
    inputHash: digest("input"),
    sources: [],
    image: null,
    ...(sourceProjectId === undefined
      ? {}
      : { sourceSnapshot: { projectId, commit: "b".repeat(40), spaceVersion: 3 } }),
  };
  const store = new PublicationRepository(db);
  const service = new PublicationService(
    {
      authorize: async (id, project) => {
        if (id !== spaceId || project !== sourceProjectId) throw new Error("Missing space");
        return { assertCurrent() {}, assertDestination() {} };
      },
      capture: async () => ({ projectId, sourceProjectId, spaceId, build, artifact }),
    },
    feature.connections,
    store,
    () => {},
  );
  const adapter = new SftpSiteDelivery(() => sites.connect(input, {}));
  return {
    ...remote,
    ...feature,
    db,
    owner,
    projectId,
    spaceId,
    connection,
    input,
    build,
    artifact,
    store,
    service,
    adapter,
    content,
    prepare: () =>
      service.prepare(owner, {
        id: randomUUID(),
        buildId: build.id,
        connectionId: connection.id,
        connectionVersion: connection.version,
        ...(sourceProjectId === undefined ? {} : { projectId }),
      }),
    run: async (repository = store) => {
      const worker = new PublicationWorker(
        repository,
        () => adapter,
        (actor, plan, check) => service.assertExecutable(actor, plan, check),
        () => {},
      );
      try {
        worker.wake();
        await worker.idle();
      } finally {
        await worker.stop();
      }
    },
    dispose: () => {
      db.close();
      remote.dispose();
    },
  };
}
