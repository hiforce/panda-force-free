import { expect, test } from "bun:test";
import { createProjectVisibilityFixture } from "./project-visibility-fixture.mjs";

test("authenticated projects persist across restart and associate historical native IDs without resuming sessions", async () => {
  const f = await createProjectVisibilityFixture({ historySessions: 1250 });
  const request = async (path: string, method = "GET", data?: any, extra = {}) => {
    const response = await fetch(f.base + path, { method, headers: { ...f.headers, "content-type": "application/json", ...extra }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect((await fetch(f.base + "/api/projects")).status).toBe(401);
    let result = await request("/api/projects");
    expect(result.body.projects).toEqual([]);
    result = await request("/api/projects", "POST", { name: "Actual project", code: "actual-project", description: "User-created, not a folder", revision: result.body.revision });
    expect(result.status).toBe(201);
    const project = result.body.projects[0];
    const forbidden = await request("/api/projects", "POST", { name: "Rejected", code: "rejected", revision: result.body.revision }, { origin: "https://evil.example" });
    expect([401, 403]).toContain(forbidden.status);
    // Search traverses native metadata pages; an old ID beyond the initial 50/1000 is selectable.
    let history = await request("/api/projects/history?search=Historical%20session%201249");
    while (!history.body.sessions.length && history.body.nextCursor)
      history = await request("/api/projects/history?search=Historical%20session%201249&cursor=" + encodeURIComponent(history.body.nextCursor));
    expect(history.body.sessions[0].id).toBe("historic-1249");
    result = await request("/api/projects/assign", "POST", { projectId: project.id, sessionIds: ["old-alpha", "old-beta", "historic-1249"], revision: result.body.revision });
    expect(result.status).toBe(200);
    expect(result.body.assignments).toHaveLength(3);
    expect(result.body.assignments.find((s: any) => s.id === "old-alpha").cwd).toBe(f.alpha);
    expect(result.body.assignments.find((s: any) => s.id === "old-beta").cwd).toBe(f.beta);
    const before = result.body;
    const invalid = await request("/api/projects/assign", "POST", { projectId: project.id, sessionIds: ["old-alpha", "does-not-exist"], revision: before.revision });
    expect(invalid.status).toBe(404);
    expect((await request("/api/projects")).body).toEqual(before);
    expect(f.calls().some((c: any) => ["thread/resume", "thread/read", "turn/start", "thread/start"].includes(c.method))).toBe(false);
    await f.stop(); await f.start();
    result = await request("/api/projects");
    expect(result.body).toEqual(before);
    result = await request("/api/projects/assign", "POST", { projectId: null, sessionIds: ["old-alpha"], revision: before.revision });
    expect(result.status).toBe(200);
    expect(result.body.assignments).toHaveLength(2);
  } finally { await f.dispose(); }
}, 20000);
