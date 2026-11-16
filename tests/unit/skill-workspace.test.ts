import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { SkillWorkspaceStore } from "../../src/server/skill-workspace/store.js";
import { SkillWorkspaceService } from "../../src/server/skill-workspace/service.js";
import { TemplateCatalog } from "../../src/server/templates/catalog.js";
import { managedTemplateKey, templateLineageKey, type ManagedTemplate } from "../../src/shared/templates/catalog.js";
import { defaultSkillWorkspace, type SkillWorkspaceCommand } from "../../src/shared/skill-workspace.js";
import { workspaceMutation } from "../../src/server/skill-workspace/validation.js";
import { builtinTemplateSource } from "../../src/server/templates/integration/presentation-source.js";
function fixture(path = ":memory:") {
  const ref = {
    registry: "skills",
    kind: "skill",
    packageId: "example.test",
    exportId: "prd",
    version: "1.0.0",
    digest: "a".repeat(64),
  } as const;
  const item: ManagedTemplate = {
    key: managedTemplateKey(ref),
    reference: ref,
    templateType: "panda.document-template",
    categories: ["writing"],
    label: { name: "PRD" },
    publisher: "Example",
    license: "MIT",
    origin: { kind: "builtin" },
    state: { enabled: true, packageEnabled: true, exportEnabled: true, active: true, removed: false },
    compatibility: { engines: [], formats: [], outputs: ["document"] },
    actions: { editor: null, preview: null, export: null, setEnabled: false, activate: false },
  };
  let items = [item],
    reads = 0;
  const catalog = new TemplateCatalog([
      {
        registry: "skills",
        async read() {
          reads++;
          return { registry: "skills", revision: String(items.length), templates: items };
        },
      },
    ]),
    store = new SkillWorkspaceStore(path),
    service = new SkillWorkspaceService(store, catalog);
  return {
    item,
    catalog,
    store,
    service,
    setItems(value: ManagedTemplate[]) {
      items = value;
    },
    reads: () => reads,
  };
}
function mutation(revision: number, command: SkillWorkspaceCommand) {
  return { operationId: randomUUID(), expectedRevision: revision, command };
}
test("personal navigation is isolated, replay-safe and atomic across classification changes", async () => {
  const f = fixture(),
    category = "custom-" + randomUUID();
  try {
    expect(await f.service.snapshot("alice")).toEqual(defaultSkillWorkspace());
    const create = mutation(0, { type: "create-category", id: category, name: { en: "Product", "zh-CN": "产品" } });
    const first = await f.service.change("alice", create);
    expect(first.revision).toBe(1);
    expect((await f.service.snapshot("bob")).revision).toBe(0);
    const assign = await f.service.change(
      "alice",
      mutation(1, { type: "assign", key: f.item.key, categoryIds: [category] }),
    );
    expect(
      (await f.catalog.list({ ...(await f.service.collection("alice", category)), view: "gallery" }, "alice")).total,
    ).toBe(1);
    const newer = { ...f.item, reference: { ...f.item.reference, version: "2.0.0" }, key: "" };
    newer.key = managedTemplateKey(newer.reference);
    f.setItems([newer]);
    expect(
      (await f.catalog.list({ ...(await f.service.collection("alice", category)), view: "gallery" }, "alice"))
        .templates[0]!.reference.version,
    ).toBe("2.0.0");
    await expect(
      f.service.change("bob", mutation(0, { type: "assign", key: newer.key, categoryIds: [category] })),
    ).rejects.toThrow("categoryMissing");
    expect(await f.service.change("alice", create)).toEqual(first);
    expect((await f.service.snapshot("alice")).revision).toBe(assign.revision);
    await expect(f.service.change("alice", { ...create, command: { type: "reset-pins" } })).rejects.toThrow("conflict");
    await f.service.change("alice", mutation(2, { type: "delete-category", id: category }));
    expect((await f.service.snapshot("alice")).assignments).toEqual({});
    await f.service.change("alice", mutation(3, { type: "delete-category", id: "writing" }));
    expect((await f.service.snapshot("alice")).categories.some((value) => value.id === "writing")).toBe(false);
  } finally {
    f.store.close();
  }
});
test("exact-version pins survive removal and restart, and revision fences reject stale writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-skill-workspace-")),
    path = join(root, "navigation.sqlite");
  let f = fixture(path);
  try {
    const initial = mutation(0, { type: "pins", pins: [{ kind: "skill", key: f.item.key }] });
    await f.service.change("alice", initial);
    f.setItems([]);
    const reads = f.reads();
    await f.service.change(
      "alice",
      mutation(1, {
        type: "pins",
        pins: [
          { kind: "skill", key: f.item.key },
          { kind: "category", id: "slides" },
        ],
      }),
    );
    expect(f.reads()).toBe(reads);
    await expect(f.service.skill("alice", f.item.key)).rejects.toThrow("skillUnavailable");
    f.store.close();
    f = fixture(path);
    expect((await f.service.snapshot("alice")).pins[0]).toMatchObject({
      kind: "skill",
      key: f.item.key,
      version: "1.0.0",
    });
    await expect(f.service.change("alice", mutation(0, { type: "reset-pins" }))).rejects.toThrow("conflict");
    const next = await f.service.change("alice", mutation(2, { type: "reset-pins" }));
    expect(next.pins).toEqual(defaultSkillWorkspace().pins);
    expect((await f.service.snapshot("bob")).revision).toBe(0);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("closed workspace commands reject authority injection and oversized or duplicate entries", () => {
  expect(() => workspaceMutation({ ...mutation(0, { type: "reset-pins" }), owner: "victim" })).toThrow("invalidInput");
  expect(() =>
    workspaceMutation(
      mutation(0, {
        type: "pins",
        pins: [
          { kind: "category", id: "writing" },
          { kind: "category", id: "writing" },
        ],
      }),
    ),
  ).toThrow("invalidInput");
  expect(() =>
    workspaceMutation(
      mutation(0, { type: "create-category", id: "custom-" + randomUUID(), name: { en: "\n", "zh-CN": "x" } }),
    ),
  ).toThrow("invalidInput");
  expect(() =>
    workspaceMutation(
      mutation(0, { type: "pins", pins: Array.from({ length: 25 }, () => ({ kind: "skill", key: "x" })) }),
    ),
  ).toThrow("invalidInput");
});

test("corrupt stored preferences fail visibly without resetting user choices", () => {
  const store = new SkillWorkspaceStore(":memory:");
  try {
    const broken = { ...defaultSkillWorkspace(), revision: 1, pins: [{ kind: "category", id: "missing" }] };
    store.db.query("INSERT INTO skill_workspaces VALUES(?,?,?)").run("alice", 1, JSON.stringify(broken));
    expect(() => store.read("alice")).toThrow("unavailable");
    expect(
      store.db.query<{ data: string }, [string]>("SELECT data FROM skill_workspaces WHERE owner=?").get("alice")?.data,
    ).toBe(JSON.stringify(broken));
    expect(store.read("bob")).toEqual(defaultSkillWorkspace());
  } finally {
    store.close();
  }
});

test("default category configuration and explicit membership survive legacy migration, deletion and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-configured-categories-")),
    path = join(root, "workspace.sqlite");
  let f = fixture(path);
  try {
    const legacy = { ...defaultSkillWorkspace(), revision: 1 };
    f.store.db.query("INSERT INTO skill_workspaces VALUES(?,?,?)").run("alice", 1, JSON.stringify(legacy));
    f.store.db.exec("PRAGMA user_version=1");
    f.store.close();
    f = fixture(path);
    expect(f.store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(2);
    expect(await f.service.snapshot("alice")).toEqual(legacy);
    expect(
      f.store.db.query<{ data: string }, [string]>("SELECT data FROM skill_workspaces WHERE owner=?").get("alice")!
        .data,
    ).toBe(JSON.stringify(legacy));
    let state = await f.service.change(
      "alice",
      mutation(1, { type: "rename-category", id: "writing", name: { en: "Drafting", "zh-CN": "文稿" } }),
    );
    const list = async (id: string) =>
      (await f.catalog.list({ ...(await f.service.collection("alice", id)), view: "gallery" }, "alice")).total;
    expect(await list("writing")).toBe(1);
    state = await f.service.change(
      "alice",
      mutation(state.revision, { type: "assign", key: f.item.key, categoryIds: ["research"], replaceDefaults: true }),
    );
    expect(await list("writing")).toBe(0);
    expect(await list("research")).toBe(1);
    state = await f.service.change(
      "alice",
      mutation(state.revision, { type: "assign", key: f.item.key, categoryIds: [] }),
    );
    expect(await list("research")).toBe(1);
    state = await f.service.change(
      "alice",
      mutation(state.revision, { type: "assign", key: f.item.key, categoryIds: [], replaceDefaults: true }),
    );
    expect(await list("writing")).toBe(0);
    expect(await list("research")).toBe(0);
    expect((await f.catalog.list({}, "alice")).total).toBe(1);
    state = await f.service.change("alice", mutation(state.revision, { type: "delete-category", id: "writing" }));
    await f.service.change("alice", mutation(state.revision, { type: "reset-pins" }));
    f.store.close();
    f = fixture(path);
    expect((await f.service.snapshot("alice")).categories.some((c) => c.id === "writing")).toBe(false);
    expect((await f.service.snapshot("alice")).pins.some((p) => p.kind === "category" && p.id === "writing")).toBe(
      false,
    );
    expect((await f.service.snapshot("bob")).categories.some((c) => c.id === "writing")).toBe(true);
    expect((await f.service.snapshot("alice")).assignmentOverrides).toHaveLength(1);
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy publication preferences cannot become AI categories, shortcuts or assigned skills", async () => {
  const f = fixture(),
    publishing = await builtinTemplateSource().read("alice"),
    publication = publishing.templates.find((item) => item.templateType === "panda.site-theme")!,
    portableReference = {
      registry: "portable",
      kind: "template",
      id: "example.site",
      version: "1",
      digest: "a",
    } as const,
    portable = { ...publication, reference: portableReference, key: managedTemplateKey(portableReference) },
    catalog = new TemplateCatalog([
      { registry: "builtin", read: async () => publishing },
      { registry: "portable", read: async () => ({ registry: "portable", revision: "1", templates: [portable] }) },
      { registry: "skills", read: async () => ({ registry: "skills", revision: "1", templates: [f.item] }) },
    ]),
    service = new SkillWorkspaceService(f.store, catalog),
    custom = "custom-" + randomUUID(),
    legacy = defaultSkillWorkspace();
  legacy.categories.push(
    { id: "site", name: { en: "Renamed sites", "zh-CN": "网站外观" }, icon: "layout", builtin: true, section: "site" },
    {
      id: "channel",
      name: { en: "Publishing styles", "zh-CN": "发布排版" },
      icon: "send",
      builtin: true,
      section: "channel",
    },
    { id: custom, name: { en: "Site themes", "zh-CN": "站点主题" }, icon: "folder", builtin: false },
  );
  legacy.pins.push(
    { kind: "category", id: "site" },
    { kind: "category", id: "channel" },
    { kind: "skill", key: publication.key, label: publication.label, version: publication.reference.version },
    { kind: "skill", key: portable.key, label: portable.label, version: portable.reference.version },
  );
  legacy.assignments[templateLineageKey(f.item.reference)] = ["writing", "site", custom];
  legacy.assignments[templateLineageKey(publication.reference)] = [custom];
  const input = mutation(0, {
      type: "pins",
      pins: legacy.pins.map((pin) => (pin.kind === "category" ? pin : { kind: "skill", key: pin.key })),
    }),
    request = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  f.store.save("alice", input.operationId, request, 0, legacy);
  const row = () => f.store.db.query<{ data: string }, []>("SELECT data FROM skill_workspaces").get()!.data,
    receipt = () =>
      f.store.db.query<{ receipt: string }, []>("SELECT receipt FROM skill_workspace_operations LIMIT 1").get()!
        .receipt,
    original = row(),
    originalReceipt = receipt();
  try {
    const snapshot = await service.snapshot("alice");
    expect(snapshot.categories.map((category) => category.id)).not.toContain("site");
    expect(snapshot.categories.map((category) => category.id)).not.toContain("channel");
    expect(snapshot.categories.find((category) => category.id === custom)?.name.en).toBe("Site themes");
    expect(snapshot.pins).toEqual(defaultSkillWorkspace().pins);
    expect(snapshot.assignments[templateLineageKey(f.item.reference)]).toEqual(["writing", custom]);
    expect(await service.change("alice", input)).toEqual(snapshot);
    expect(row()).toBe(original);
    expect(receipt()).toBe(originalReceipt);
    await expect(service.collection("alice", "site")).rejects.toThrow("categoryMissing");
    expect(
      (await catalog.list({ ...(await service.collection("alice", custom)) }, "alice")).templates.map(
        (item) => item.key,
      ),
    ).toEqual([f.item.key]);
    for (const key of [publication.key, portable.key]) {
      await expect(service.skill("alice", key)).rejects.toThrow("skillUnavailable");
      await expect(
        service.change("alice", mutation(1, { type: "assign", key, categoryIds: [custom] })),
      ).rejects.toThrow("skillUnavailable");
      await expect(
        service.change("alice", mutation(1, { type: "pins", pins: [{ kind: "skill", key }] })),
      ).rejects.toThrow("skillUnavailable");
    }
    await expect(
      service.change("alice", mutation(1, { type: "assign", key: f.item.key, categoryIds: ["channel"] })),
    ).rejects.toThrow("categoryMissing");
    await service.change(
      "alice",
      mutation(1, { type: "rename-category", id: "writing", name: { en: "Drafting", "zh-CN": "文稿" } }),
    );
    expect(f.store.read("alice").categories.find((category) => category.id === "site")?.name.en).toBe("Renamed sites");
    expect(f.store.read("alice").assignments[templateLineageKey(f.item.reference)]).toContain("site");
    expect(receipt()).toBe(originalReceipt);
    expect(
      (await catalog.list({ domain: "publishing", section: "site", engine: "hexo" }, "alice")).total,
    ).toBeGreaterThan(1);
    expect((await service.snapshot("bob")).categories).toHaveLength(6);
  } finally {
    f.store.close();
  }
});

test("regional category labels upgrade on read without rewriting preferences and older editors preserve them", async () => {
  const f = fixture(),
    legacy = defaultSkillWorkspace();
  for (const category of legacy.categories) category.name = { en: category.name.en, "zh-CN": category.name["zh-CN"] };
  legacy.revision = 1;
  f.store.db.query("INSERT INTO skill_workspaces VALUES(?,?,?)").run("alice", 1, JSON.stringify(legacy));
  try {
    const projected = await f.service.snapshot("alice");
    expect(projected.categories.find((c) => c.id === "slides")?.name["zh-HK"]).toBe("投影片");
    expect(projected.categories.find((c) => c.id === "slides")?.name["zh-TW"]).toBe("簡報");
    expect(f.store.read("alice")).toEqual(legacy);
    await f.service.change(
      "alice",
      mutation(1, {
        type: "rename-category",
        id: "writing",
        name: { en: "My writing", "zh-CN": "我的写作", "zh-HK": "香港寫作", "zh-TW": "台灣寫作" },
      }),
    );
    await f.service.change(
      "alice",
      mutation(2, { type: "rename-category", id: "writing", name: { en: "Drafts", "zh-CN": "文稿" } }),
    );
    expect((await f.service.snapshot("alice")).categories.find((c) => c.id === "writing")?.name["zh-HK"]).toBe(
      "香港寫作",
    );
    await f.service.change(
      "alice",
      mutation(3, {
        type: "rename-category",
        id: "writing",
        name: { en: "Drafts", "zh-CN": "文稿", "zh-HK": "", "zh-TW": "台灣文稿" },
      }),
    );
    expect(f.store.read("alice").categories.find((c) => c.id === "writing")?.name["zh-HK"]).toBe("");
    expect((await f.service.snapshot("alice")).categories.find((c) => c.id === "writing")?.name["zh-TW"]).toBe(
      "台灣文稿",
    );
    await expect(
      f.service.change(
        "alice",
        mutation(4, {
          type: "rename-category",
          id: "writing",
          name: { en: "Drafts", "zh-CN": "文稿", "zh-TW": "字".repeat(65) },
        }),
      ),
    ).rejects.toThrow("invalidInput");
  } finally {
    f.store.close();
  }
});
