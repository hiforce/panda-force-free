import { expect, test } from "bun:test";
import { createI18nRuntime } from "../../src/shared/i18n/runtime.js";
import { serverMessages } from "../../src/shared/i18n/server-catalogs.js";
import { englishMessages } from "../../src/shared/i18n/catalogs.js";
import { REQUIRED_LOCALE_CODES, resolveLocale } from "../../src/shared/i18n/locale-policy.js";
import { requestLocale } from "../../src/server/i18n/request-locale.js";
import { serverTranslator } from "../../src/server/i18n/messages.js";
import { localizedText } from "../../src/shared/presentation/localized.js";
import { skillDisplayDefinition, skillDisplayPackName } from "../../src/shared/presentation/skill-display.js";
import { builtinEssentialsPack } from "../../src/server/skills/builtin/essentials.js";
import type { InstalledSkillPack } from "../../src/shared/skills/registry.js";
import { auditCatalogCoverage } from "../../scripts/i18n/catalog-contract.mjs";
import { SkillWorkspaceStore } from "../../src/server/skill-workspace/store.js";
import { SkillWorkspaceService } from "../../src/server/skill-workspace/service.js";
import { TemplateCatalog } from "../../src/server/templates/catalog.js";
import { skillTemplateSource } from "../../src/server/templates/integration/skill-source.js";
import { defaultSkillWorkspace } from "../../src/shared/skill-workspace.js";

test("regional preferences preserve script, explicit choice, formatting locale and request negotiation", async () => {
  expect(REQUIRED_LOCALE_CODES).toEqual(["en", "zh-CN", "zh-HK", "zh-TW"]);
  expect(resolveLocale("zh-HK", ["zh-TW"])).toBe("zh-HK");
  expect(resolveLocale("zh-TW", ["zh-HK"])).toBe("zh-TW");
  expect(resolveLocale("system", ["zh-Hans-HK", "zh-TW"])).toBe("zh-CN");
  expect(resolveLocale("system", ["zh-Hant-TW"])).toBe("zh-TW");
  expect(requestLocale({ headers: { "accept-language": "zh-Hant-HK;q=1,zh-TW;q=0.9,en;q=0.8" } })).toBe("zh-HK");
  expect(requestLocale({ headers: { cookie: "panda-force-locale=zh-TW", "accept-language": "zh-HK" } })).toBe("zh-TW");
  for (const locale of ["zh-HK", "zh-TW"] as const) {
    const runtime = createI18nRuntime({ preference: locale, resources: serverMessages, timeZone: "UTC" });
    await runtime.ready;
    expect(runtime.locale).toBe(locale);
    expect(runtime.t("common.projects")).toBe(locale === "zh-HK" ? "項目" : "專案");
    expect(serverTranslator(locale)("common.projects")).toBe(runtime.t("common.projects"));
    const options = { timeZone: "UTC", dateStyle: "medium" as const, timeStyle: "short" as const },
      date = new Date("2026-11-13T17:30:00Z");
    expect(runtime.format.dateTime(date, options)).toBe(new Intl.DateTimeFormat(locale, options).format(date));
    expect(runtime.format.number(1234.5)).toBe(new Intl.NumberFormat(locale).format(1234.5));
  }
});

test("missing regional packs fall back to English and can retry the original preference", async () => {
  let failed = true;
  const runtime = createI18nRuntime({
    preference: "zh-HK",
    loaders: {
      "zh-HK": async () => {
        if (failed) throw new Error("offline");
        return serverMessages["zh-HK"];
      },
    },
  });
  await runtime.ready;
  expect(runtime.preference).toBe("zh-HK");
  expect(runtime.locale).toBe("en");
  expect(runtime.t("common.projects")).toBe("Projects");
  failed = false;
  await runtime.setPreference("zh-HK");
  expect(runtime.t("common.projects")).toBe("項目");
});

test("metadata accepts script-neutral traditional labels without borrowing simplified or sibling regional text", () => {
  expect(localizedText({ en: "English", "zh-CN": "简体", "zh-Hant": "繁體共用" }, "zh-HK")).toBe("繁體共用");
  expect(localizedText({ en: "English", "zh-Hant-HK": "香港", "zh-Hant-TW": "台灣" }, "zh-TW")).toBe("台灣");
  expect(localizedText({ en: "English", "zh-CN": "简体", "zh-HK": "香港" }, "zh-TW")).toBe("English");
});

test("complete published catalogs reject missing languages, blank entries and changed ICU contracts", () => {
  const complete = new Map<string, Record<string, string>>(
    REQUIRED_LOCALE_CODES.map((locale) => [locale, { "feature.ready": "Ready {count, number}" }]),
  );
  expect(auditCatalogCoverage(complete, REQUIRED_LOCALE_CODES).failures).toEqual([]);
  const missing = new Map(complete);
  missing.delete("zh-TW");
  expect(auditCatalogCoverage(missing, REQUIRED_LOCALE_CODES).failures.join(" ")).toContain("zh-TW");
  for (const text of ["", "Ready {count}", "Ready {other, number}"]) {
    const changed = new Map(complete);
    changed.set("zh-HK", { "feature.ready": text });
    expect(auditCatalogCoverage(changed, REQUIRED_LOCALE_CODES).failures.length).toBeGreaterThan(0);
  }
  const newFeature = new Map(complete);
  newFeature.set("en", {
    "feature.ready": "Ready {count, number}",
    "feature.new": "New",
  });
  expect(
    auditCatalogCoverage(newFeature, REQUIRED_LOCALE_CODES).failures.filter((value) => value.includes("feature.new")),
  ).toHaveLength(3);
  expect(Object.keys(serverMessages["zh-HK"])).toEqual(Object.keys(englishMessages));
  expect(serverMessages["zh-TW"].documents.applyProperties).toBe("套用設定");
  expect(serverMessages["zh-TW"].knowledge.rulesSaved).toBe("規則已套用。");
});

test("trusted builtin regional display text preserves immutable bundles and customer metadata", async () => {
  const verified = await builtinEssentialsPack(),
    before = JSON.stringify(verified.manifest);
  const pack: InstalledSkillPack = {
    id: verified.manifest.id,
    version: verified.manifest.version,
    digest: verified.digest,
    manifest: verified.manifest,
    origin: { kind: "builtin", id: verified.manifest.id },
    installedAt: 1,
    installedBy: "system",
    removed: false,
    active: true,
    exports: [],
    grants: [],
  };
  const original = verified.manifest.skills.find((value) => value.id === "software-prd")!,
    display = skillDisplayDefinition(pack, original);
  expect(display.name["zh-HK"]).toBe("軟件需求 PRD");
  expect(display.name["zh-TW"]).toBe("軟體需求 PRD");
  expect(display.parameters[0]!.label["zh-TW"]).toBe("目標讀者");
  expect(display.instructions).toBe(original.instructions);
  expect(display.capabilities).toBe(original.capabilities);
  expect(display.readme?.["zh-TW"]).toContain("可編輯文件");
  expect(skillDisplayPackName(pack)["zh-HK"]).toBe("日常創作技能");
  expect(JSON.stringify(verified.manifest)).toBe(before);
  const customer = { ...pack, origin: { kind: "upload", name: "customer.json", sha256: verified.digest } as const };
  expect(skillDisplayDefinition(customer, original)).toBe(original);
  expect(skillDisplayDefinition({ ...pack, version: "2.0.0" }, original)).toBe(original);
  const store = new SkillWorkspaceStore(":memory:");
  let publicationReads = 0;
  const catalog = new TemplateCatalog([
    skillTemplateSource(() => ({ revision: 1, packages: [pack], nextCursor: null })),
    {
      registry: "builtin",
      async read() {
        publicationReads++;
        throw new Error("unrelated publishing catalog unavailable");
      },
    },
  ]);
  try {
    const item = (
      await skillTemplateSource(() => ({ revision: 1, packages: [pack], nextCursor: null })).read()
    ).templates.find((value) => value.reference.registry === "skills" && value.reference.exportId === "software-prd")!;
    const state = defaultSkillWorkspace();
    state.pins = [
      {
        kind: "skill",
        key: item.key,
        label: { name: original.name.en, labels: { "zh-CN": { name: original.name["zh-CN"]!, description: "" } } },
        version: pack.version,
      },
    ];
    store.save("owner", "seed", "seed", 0, state);
    const service = new SkillWorkspaceService(store, catalog),
      snapshot = await service.snapshot("owner");
    const pin = snapshot.pins[0]!;
    expect(pin.kind === "skill" && pin.label.labels?.["zh-HK"]?.name).toBe("軟件需求 PRD");
    expect(store.read("owner").pins).toEqual(state.pins);
    expect(publicationReads).toBe(0);
  } finally {
    store.close();
  }
});

test("partial core packs do not create mixed-language interfaces or require plugin translations", async () => {
  let complete = false;
  const runtime = createI18nRuntime({
    loaders: { "zh-TW": async () => (complete ? serverMessages["zh-TW"] : { common: { cancel: "取消" } }) },
  });
  await runtime.ready;
  await runtime.registerNamespace("plugin.optional", { en: { label: "External label" } });
  await runtime.setPreference("zh-TW");
  expect(runtime.locale).toBe("en");
  complete = true;
  await runtime.setPreference("zh-TW");
  expect(runtime.locale).toBe("zh-TW");
  expect(runtime.t("plugin.optional.label")).toBe("External label");
});

test("new feature error envelopes use every registered core namespace while native diagnostics stay opaque", async () => {
  const { errorPayload } = await import("../../src/server/i18n/error-payload.js");
  const { errorText } = await import("../../src/client/i18n/errors.js");
  for (const locale of REQUIRED_LOCALE_CODES) {
    const runtime = createI18nRuntime({ preference: locale, resources: serverMessages });
    await runtime.ready;
    for (const id of ["skillWorkspace.unavailable", "creation.unavailable", "previews.invalidInput"] as const)
      expect(errorText(errorPayload(id), runtime.t)).toBe(runtime.t(id));
    expect(errorText({ error: "CLI 原文 Settings 软件" }, runtime.t)).toBe("CLI 原文 Settings 软件");
    expect(errorText({ error: "common.cancel" }, runtime.t)).toBe("common.cancel");
  }
});

test("direct build checks block untranslated additions without changing the developer worktree", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "panda-regional-gate-"));
  const module = new URL("../../scripts/i18n/published-catalogs.mjs", import.meta.url).href;
  try {
    for (const locale of REQUIRED_LOCALE_CODES) {
      const dir = join(root, "src/shared/i18n/locales", locale);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "common.json"), JSON.stringify({ ready: "Ready {count, number}" }));
    }
    const run = async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `import {assertPublishedCatalogs} from ${JSON.stringify(module)};assertPublishedCatalogs();`,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const error = await new Response(child.stderr).text();
      return { code: await child.exited, error };
    };
    expect((await run()).code).toBe(0);
    await writeFile(
      join(root, "src/shared/i18n/locales/en/common.json"),
      JSON.stringify({ ready: "Ready {count, number}", newFeature: "New feature" }),
    );
    const failed = await run();
    expect(failed.code).not.toBe(0);
    expect(failed.error).toContain("zh-HK: missing common.newFeature");
    expect(failed.error).toContain("zh-TW: missing common.newFeature");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
