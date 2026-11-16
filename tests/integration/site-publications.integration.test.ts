import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createSiteBuildFixture } from "../support/site-build-fixture.mjs";
import { waitFor } from "../support/app-fixture.mjs";

test("authenticated publication routes freeze builds, persist plans and publish only after an explicit command", async () => {
  const fixture = await createSiteBuildFixture(),
    app = fixture.app;
  const call = async (path: string, method = "GET", body?: unknown, headers = {}) => {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(fixture.app.legacyProject(body), { status: 201 })
        : await fetch(app.base + path, {
            method,
            headers: { ...app.headers, "content-type": "application/json", ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect((await fetch(app.base + "/api/publication-connections/roots")).status).toBe(401);
    expect((await call("/api/publication-connections/roots")).body.messageId).toBe("connections.identityRequired");
    expect((await call("/api/auth/setup", "POST", { username: "publication-owner" })).status).toBe(200);
    const roots = (await call("/api/publication-connections/roots")).body.roots;
    const catalog = (await call("/api/projects")).body;
    const project = (
      await call("/api/projects", "POST", {
        code: "publication",
        name: "Publication fixture",
        revision: catalog.revision,
      })
    ).body.projects[0];
    const space = (
      await call("/api/document-spaces", "POST", {
        projectId: project.id,
        code: "site",
        name: "Fixture site",
        engine: "hexo",
        sourceMode: "managed",
        locale: "en",
      })
    ).body.space;
    await call("/api/documents", "POST", {
      spaceId: space.id,
      path: "index.md",
      title: "Fixture article",
      locale: "en",
      content: "Publication fixture.",
    });
    const buildId = randomUUID();
    expect(
      (
        await call("/api/site-builds", "POST", {
          id: buildId,
          spaceId: space.id,
          engine: "hexo",
          title: "Fixture",
          locale: "en",
          url: "https://example.com",
          basePath: "/docs/",
        })
      ).status,
    ).toBe(202);
    await waitFor(async () => (await call("/api/site-builds/detail?id=" + buildId)).body.build.phase === "completed");
    const input = {
      id: randomUUID(),
      projectId: project.id,
      name: "Test site",
      connector: "local-site",
      root: roots[0].id,
      directory: "isolated-site",
      publicUrl: "https://example.com/docs/",
    };
    expect([401, 403]).toContain(
      (await call("/api/publication-connections", "POST", input, { origin: "https://foreign.example" })).status,
    );
    expect((await call("/api/publication-connections", "POST", { ...input, ownerId: "someone-else" })).status).toBe(
      400,
    );
    const connection = (await call("/api/publication-connections", "POST", input)).body.connection;
    const request = { id: randomUUID(), buildId, connectionId: connection.id, connectionVersion: connection.version };
    const prepared = await call("/api/site-publications", "POST", request);
    expect(prepared.status).toBe(201);
    expect(prepared.body.publication.job.phase).toBe("prepared");
    expect(readdirSync(roots[0].path)).toEqual([]);
    expect((await call("/api/site-builds/detail?id=" + buildId, "DELETE")).status).toBe(200);
    await app.stop();
    await app.start();
    const reloaded = (await call("/api/site-publications/detail?id=" + request.id)).body.publication;
    expect(reloaded.plan.fingerprint).toBe(prepared.body.publication.plan.fingerprint);
    expect(reloaded.job.phase).toBe("prepared");
    expect(
      (await call("/api/site-publications/publish", "POST", { id: request.id, fingerprint: "0".repeat(64) })).status,
    ).toBe(409);
    expect(
      (await call("/api/site-publications/publish", "POST", { id: request.id, fingerprint: reloaded.plan.fingerprint }))
        .status,
    ).toBe(202);
    const published = await waitFor(async () => {
      const result = (await call("/api/site-publications/detail?id=" + request.id)).body.publication;
      return result.job.phase === "published" ? result : false;
    });
    expect(readFileSync(join(roots[0].path, "isolated-site", "current", "index.html"), "utf8")).toContain(
      "Fixture website",
    );
    expect(published.job.receipt.publicUrl).toBe(input.publicUrl);
    expect(published.job.receipt.previousRelease).toBeNull();
    expect(
      (await call("/api/site-publications/publish", "POST", { id: request.id, fingerprint: reloaded.plan.fingerprint }))
        .body.publication.job.receipt,
    ).toEqual(published.job.receipt);
    expect(readdirSync(join(roots[0].path, "isolated-site", "releases"))).toEqual([request.id]);
    expect((await call("/api/publication-connections?project=" + project.id)).body.connections).toHaveLength(1);
    const remote = (
      await call("/api/publication-connections", "POST", {
        id: randomUUID(),
        projectId: project.id,
        name: "SFTP fixture",
        connector: "sftp-site",
        host: "example.test",
        port: 22,
        username: "publisher",
        directory: "/fixture",
        publicUrl: "https://example.com/docs/",
        hostKey: "SHA256:" + Buffer.alloc(32, 1).toString("base64").replace(/=$/, ""),
      })
    ).body.connection;
    const credentialPath = "/api/publication-connections/credentials?id=" + remote.id;
    const secret = { version: 1, credential: { method: "password", password: "fixture-api-secret" } };
    expect((await fetch(app.base + credentialPath, { method: "PUT", body: JSON.stringify(secret) })).status).toBe(401);
    expect([401, 403]).toContain(
      (await call(credentialPath, "PUT", secret, { origin: "https://foreign.example" })).status,
    );
    expect((await call(credentialPath, "PUT", { ...secret, extra: "unexpected" })).status).toBe(400);
    const saved = await call(credentialPath, "PUT", secret);
    expect(saved.status).toBe(200);
    expect(saved.body.connection.credentialRevision).toBe(1);
    expect(saved.body.connection.version).toBe(2);
    expect(JSON.stringify(saved.body)).not.toContain(secret.credential.password);
    expect((await call(credentialPath, "PUT", secret)).status).toBe(409);
    expect((await call(credentialPath)).status).not.toBe(200);
    const trustPath = "/api/publication-connections/trust?id=" + remote.id;
    const newTrust = { version: 2, hostKey: "SHA256:" + Buffer.alloc(32, 2).toString("base64").replace(/=$/, "") };
    expect((await fetch(app.base + trustPath, { method: "PUT", body: JSON.stringify(newTrust) })).status).toBe(401);
    expect([401, 403]).toContain(
      (await call(trustPath, "PUT", newTrust, { origin: "https://foreign.example" })).status,
    );
    expect((await call(trustPath, "PUT", { ...newTrust, host: "other.example" })).status).toBe(400);
    const rotated = await call(trustPath, "PUT", newTrust);
    expect(rotated.status).toBe(200);
    expect(rotated.body.connection.version).toBe(3);
    expect(rotated.body.connection.trustPending).toBe(true);
    expect((await call(trustPath, "PUT", newTrust)).status).toBe(409);
    const metadata = await call("/api/publication-connections/detail?id=" + remote.id);
    expect(metadata.body.connection.hostKey).toBe(newTrust.hostKey);
    expect(metadata.body.connection.credentialRevision).toBe(1);
    expect(JSON.stringify(metadata.body)).not.toContain(secret.credential.password);
    await app.stop();
    await app.start();
    const listed = (await call("/api/publication-connections?project=" + project.id)).body.connections;
    expect(listed.find((item: { id: string }) => item.id === remote.id).credentialRevision).toBe(1);
    expect(listed.find((item: { id: string }) => item.id === remote.id).trustPending).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(secret.credential.password);
    expect(app.calls().some((entry: { method?: string }) => entry.method === "turn/start")).toBe(false);
  } finally {
    await fixture.dispose();
  }
}, 40000);
