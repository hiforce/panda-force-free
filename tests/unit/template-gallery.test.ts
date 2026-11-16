import { test, expect } from "bun:test";
import { TemplateCatalog } from "../../src/server/templates/catalog.js";
import { managedTemplateKey, type ManagedTemplate } from "../../src/shared/templates/catalog.js";
function entry(id: string, version: string, active: boolean): ManagedTemplate {
  const reference = {
    registry: "skills",
    kind: "skill",
    packageId: "example.skills",
    exportId: id,
    version,
    digest: version,
  } as const;
  return {
    key: managedTemplateKey(reference),
    reference,
    templateType: "panda.document-template",
    categories: ["writing"],
    label: { name: id, description: "", labels: {} },
    publisher: null,
    license: null,
    origin: { kind: "installed" },
    state: { enabled: true, packageEnabled: true, exportEnabled: true, active, removed: false },
    compatibility: { engines: [], formats: [], outputs: ["document"] },
    actions: { editor: null, preview: "skill-template", export: "skill-package", setEnabled: true, activate: true },
  };
}
test("gallery pagination chooses one selected version per skill; historical releases remain addressable", async () => {
  const rows = [
    entry("alpha", "1.0.0", true),
    entry("alpha", "2.0.0", false),
    entry("beta", "1.0.0", false),
    entry("beta", "1.1.0", false),
    entry("gamma", "1.0.0", true),
  ];
  const catalog = new TemplateCatalog([
    { registry: "skills", read: async () => ({ registry: "skills", revision: "revision-1", templates: rows }) },
  ]);
  const first = await catalog.list({ view: "gallery", limit: 1 });
  expect(first.total).toBe(3);
  expect(first.templates[0]!.reference.version).toBe("1.0.0");
  const second = await catalog.list({ view: "gallery", limit: 1, cursor: first.nextCursor! });
  expect(second.templates[0]!.reference.version).toBe("1.1.0");
  const third = await catalog.list({ view: "gallery", limit: 1, cursor: second.nextCursor! });
  expect(third.nextCursor).toBeNull();
  expect(new Set([...first.templates, ...second.templates, ...third.templates].map((x) => x.key)).size).toBe(3);
  expect((await catalog.list({ view: "versions" })).total).toBe(5);
  await expect(catalog.list({ view: "versions", limit: 1, cursor: first.nextCursor! })).rejects.toThrow();
});
