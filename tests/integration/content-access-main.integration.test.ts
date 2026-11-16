import { expect, test } from "bun:test";
import { idaasContentFixture, contentFixtureOwner } from "../support/idaas-content-fixture.mjs";
import { waitFor } from "../support/app-fixture.mjs";
import { randomUUID } from "node:crypto";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";

test("production web, search and registered CLI use durable per-user project membership through real OIDC identities", async () => {
  const f = await idaasContentFixture();
  try {
    const admin = await f.login("admin"),
      alice = await f.login("alice"),
      bob = await f.login("bob");
    const json = async (cookie: string, path: string, body?: unknown, method?: string) => {
      const response = await f.api(cookie, path, body, method);
      const diagnostic = response.ok ? "" : await response.clone().text();
      expect(response.ok, path + " returned " + response.status + ": " + diagnostic).toBe(true);
      return response.json();
    };
    const initial = await json(admin, "/api/projects"),
      catalog = await json(admin, "/api/projects", {
        code: "authorized-project",
        name: "Authorized project",
        revision: initial.revision,
      }),
      project = catalog.projects.find((p: { code: string }) => p.code === "authorized-project").id;
    expect((await json(alice, "/api/content-access")).projects).toEqual([]);
    expect((await f.api(alice, "/api/content-access/grants?project=" + project)).status).toBe(403);
    expect(
      (
        await f.api(
          alice,
          "/api/content-access/grants",
          { project, owner: contentFixtureOwner("alice"), role: "contributor", revision: 0 },
          "PUT",
        )
      ).status,
    ).toBe(403);
    const registration = {
      name: "Alice scoped client",
      kind: "claude",
      projects: [project],
      capabilities: ["content:read", "search:read", "knowledge:write"],
      expiresInDays: 1,
    };
    expect((await f.api(alice, "/api/cli/clients", registration)).status).toBe(404);
    expect((await f.api(alice, "/api/search/query", { project, query: "sentinel" })).status).toBe(404);
    expect((await f.api(bob, "/api/knowledge/generation-policy?project=" + project)).status).toBe(404);
    const grants = await json(admin, "/api/content-access/grants?project=" + project);
    await json(
      admin,
      "/api/content-access/grants",
      { project, owner: contentFixtureOwner("alice"), role: "reader", revision: grants.revision },
      "PUT",
    );
    expect((await json(alice, "/api/content-access")).projects).toEqual([
      { id: project, name: "Authorized project", role: "reader" },
    ]);
    expect((await json(bob, "/api/content-access")).projects).toEqual([]);
    const tree = await json(admin, "/api/project-document-tree?project=" + project),
      document = await json(admin, "/api/project-document-tree/documents", {
        id: randomUUID(),
        projectId: project,
        treeVersion: tree.version,
        title: "Membership sentinel",
        locale: "en",
        parentId: null,
      }),
      documentId = document.operation.documentId,
      client = await json(alice, "/api/cli/clients", registration);
    const command = (command: string, args: Record<string, unknown>) =>
      fetch(f.base + "/api/cli/v1/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-panda-cli-protocol": "1",
          "x-panda-client-id": client.registration.clientId,
          authorization: "Bearer " + client.apiKey,
        },
        body: JSON.stringify({ schema: 1, command, args }),
      });
    const read = await command("documents.read", { project, id: documentId });
    expect(read.status).toBe(200);
    expect((await read.json()).data.document.title).toBe("Membership sentinel");
    expect(
      (
        await command("knowledge.create", {
          project,
          id: randomUUID(),
          ids: [documentId],
          purpose: "Explain this document",
        })
      ).status,
    ).toBe(404);
    expect((await f.api(alice, "/api/knowledge/generation-policy?project=" + project)).status).toBe(404);
    await json(alice, "/api/search/query", { project, query: "sentinel" });
    await waitFor(async () => {
      const result = await json(alice, "/api/search/query", { project, query: "sentinel" });
      return result.hits.some((hit: { id: string }) => hit.id === documentId);
    });
    const editor = await json(
        admin,
        "/api/project-documents/editor?" + new URLSearchParams({ project, id: documentId }),
      ),
      indexed = await json(admin, "/api/search/status?" + new URLSearchParams({ project }));
    expect(typeof editor.saved.document.path).toBe("string");
    const selected = { ...DEFAULT_SEARCH_SETTINGS, enabled: true, exclude: [editor.saved.document.path] };
    await json(
      admin,
      "/api/search/settings",
      { project, source: "builtin", settings: selected, revision: indexed.revision },
      "PUT",
    );
    const beforeBob = await json(admin, "/api/content-access/grants?project=" + project);
    await json(
      admin,
      "/api/content-access/grants",
      { project, owner: contentFixtureOwner("bob"), role: "reader", revision: beforeBob.revision },
      "PUT",
    );
    const bobIndex = await json(bob, "/api/search/status?" + new URLSearchParams({ project }));
    expect(bobIndex.revision).toBe(indexed.revision + 1);
    expect(bobIndex.settings.exclude).toEqual(selected.exclude);
    expect((await json(bob, "/api/search/query", { project, query: "sentinel" })).hits).toEqual([]);
    expect((await json(alice, "/api/search/query", { project, query: "sentinel" })).hits).toEqual([]);
    expect(
      (
        await f.api(
          alice,
          "/api/search/previous-settings?" + new URLSearchParams({ project, source: "builtin", offset: "0" }),
        )
      ).status,
    ).toBe(403);
    await json(
      admin,
      "/api/search/settings",
      { project, source: "builtin", settings: { ...selected, exclude: [] }, revision: bobIndex.revision },
      "PUT",
    );
    const withBob = await json(admin, "/api/content-access/grants?project=" + project);
    await json(
      admin,
      "/api/content-access/grants",
      { project, owner: contentFixtureOwner("bob"), role: null, revision: withBob.revision },
      "PUT",
    );
    expect((await f.api(bob, "/api/search/query", { project, query: "sentinel" })).status).toBe(404);
    const latest = await json(admin, "/api/content-access/grants?project=" + project);
    await json(
      admin,
      "/api/content-access/grants",
      { project, owner: contentFixtureOwner("alice"), role: null, revision: latest.revision },
      "PUT",
    );
    for (const response of [
      await command("documents.read", { project, id: documentId }),
      await command("search.query", { project, query: "sentinel" }),
      await f.api(alice, "/api/search/query", { project, query: "sentinel" }),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("Membership sentinel");
    }
    expect((await json(alice, "/api/content-access")).projects).toEqual([]);
    await f.stop();
    await f.start();
    expect((await command("documents.read", { project, id: documentId })).status).toBe(404);
    const newAdmin = await f.login("admin"),
      newAlice = await f.login("alice");
    expect((await json(newAlice, "/api/content-access")).projects).toEqual([]);
    expect((await json(newAdmin, "/api/content-access/grants?project=" + project)).grants).toEqual([
      { owner: contentFixtureOwner("admin"), role: "contributor", updatedAt: expect.any(Number) },
    ]);
  } finally {
    await f.close();
  }
}, 60000);
