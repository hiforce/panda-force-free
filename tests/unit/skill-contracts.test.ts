import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { verifySkillResources } from "../../src/shared/skills/resources.js";
import { validateSkillManifest, assertSkillCompatibility } from "../../src/shared/skills/manifest.js";
import { composeSkills, type SelectedSkill } from "../../src/shared/skills/composition.js";
import { SKILL_CAPABILITIES, type SkillResource } from "../../src/shared/skills/contracts.js";
import { SkillContractError, type SkillErrorCode } from "../../src/shared/skills/errors.js";

function fixture(change?: (manifest: any) => void) {
  const root = new URL("../fixtures/skill-packs/writing-kit/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("panda-skills.json", root), "utf8"));
  const resources: SkillResource[] = manifest.files.map((path: string) => ({
    path,
    bytes: new Uint8Array(readFileSync(new URL(path, root))),
  }));
  change?.(manifest);
  return { manifest, raw: new TextEncoder().encode(JSON.stringify(manifest)), resources };
}
const authority = {
  applicationVersion: "0.0.14",
  outputType: "document" as const,
  available: new Set(SKILL_CAPABILITIES),
  granted: new Set(SKILL_CAPABILITIES),
  entitled: new Set<string>(),
};
async function code(expected: SkillErrorCode, run: () => unknown | Promise<unknown>) {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SkillContractError);
  expect((error as SkillContractError).code).toBe(expected);
}
async function pack(change?: (manifest: any) => void) {
  const value = fixture(change);
  return verifySkillResources(value.raw, value.resources);
}
function chosen(value: Awaited<ReturnType<typeof pack>>, id: string, parameters: unknown = {}): SelectedSkill {
  return { pack: value, id, parameters };
}

describe("skill pack contracts and immutable content", () => {
  test("contributed multi-export fixture and digest follow the independent published algorithm", async () => {
    const value = fixture(),
      verified = await verifySkillResources(value.raw, [...value.resources].reverse());
    const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
    const records = [...value.resources]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((file) => [file.path, file.bytes.length, hash(file.bytes)]);
    expect(verified.digest).toBe(hash("PandaForce-SkillPack-v1\n" + JSON.stringify([hash(value.raw), records])));
    expect(verified.manifest.skills.map((item) => item.id)).toEqual(["writing", "blog-outline", "brand-voice"]);
    expect(verified.digest).toBe((await verifySkillResources(value.raw, value.resources)).digest);
    expect(verified.digest).not.toBe(
      (await verifySkillResources(new TextEncoder().encode(" " + new TextDecoder().decode(value.raw)), value.resources))
        .digest,
    );
  });
  test("verification captures caller bytes before asynchronous hashing and readers cannot mutate content", async () => {
    const value = fixture(),
      expected = await verifySkillResources(value.raw, value.resources),
      flight = verifySkillResources(value.raw, value.resources);
    value.raw.fill(0);
    for (const file of value.resources) file.bytes.fill(0);
    const verified = await flight;
    expect(verified.digest).toBe(expected.digest);
    const path = verified.manifest.skills[0]!.instructions,
      copy = verified.read(path);
    copy.fill(0);
    const rawCopy = verified.readManifest();
    rawCopy.fill(0);
    expect(JSON.parse(new TextDecoder().decode(verified.readManifest())).id).toBe("example.writing-kit");
    expect(verified.text(path)).toBe(expected.text(path));
    expect(Object.isFrozen(verified.manifest.skills[0])).toBe(true);
  });
  test("closed fields and unknown capabilities cannot request extra execution privileges", async () => {
    await code("invalidManifest", () =>
      pack((m) => {
        m.installScript = "run.sh";
      }),
    );
    await code("invalidManifest", () =>
      pack((m) => {
        m.skills[0].capabilities.push("shell.execute");
      }),
    );
    await code("invalidManifest", () =>
      pack((m) => {
        m.skills[0].parameters.push({
          id: "token",
          type: "boolean",
          label: { en: "Token" },
          required: false,
          command: "env",
        });
      }),
    );
    const value = fixture();
    Object.defineProperty(value.manifest, "name", {
      get() {
        throw new Error("Getter executed");
      },
      enumerable: true,
    });
    await code("invalidManifest", () => validateSkillManifest(value.manifest));
  });
  test("paths are portable and case aliases, hidden credentials and executable resources are rejected", async () => {
    for (const path of [
      "../outside.md",
      "/root.md",
      "C:/root.md",
      "folder\\body.md",
      ".codex/instructions.md",
      "assets/CON.txt",
      "auth.json",
    ])
      await code("invalidResourcePath", () =>
        pack((m) => {
          m.files[0] = path;
        }),
      );
    await code("invalidManifest", () => pack((m) => m.files.push("license")));
    await code("invalidResourcePath", () => pack((m) => m.files.push("Assets/first.md", "assets/second.md")));
    await code("invalidResourcePath", () => pack((m) => m.files.push("LICENSE/child.txt")));
    const manifestCollision = fixture().manifest;
    manifestCollision.files.push("Panda-skills.json/child.md");
    await code("invalidResourcePath", () => validateSkillManifest(manifestCollision));
    const value = fixture();
    value.manifest.files.push("install.py");
    value.resources.push({ path: "install.py", bytes: new TextEncoder().encode("print('never execute')") });
    await code("invalidResource", () =>
      verifySkillResources(new TextEncoder().encode(JSON.stringify(value.manifest)), value.resources),
    );
    const disguised = fixture();
    disguised.manifest.license.file = "license.py";
    disguised.manifest.files[0] = "license.py";
    disguised.resources[0] = { path: "license.py", bytes: new TextEncoder().encode("Not an executable license") };
    await code("invalidResource", () =>
      verifySkillResources(new TextEncoder().encode(JSON.stringify(disguised.manifest)), disguised.resources),
    );
  });
  test("declared files and instruction references are complete and byte limited", async () => {
    const value = fixture();
    await code("missingResource", () => verifySkillResources(value.raw, value.resources.slice(1)));
    await code("invalidResourcePath", () => verifySkillResources(value.raw, [...value.resources, value.resources[0]!]));
    await code("missingResource", () =>
      pack((m) => {
        m.skills[0].instructions = "missing.md";
      }),
    );
    const oversized = value.resources.map((file) =>
      file.path === value.manifest.skills[0].instructions
        ? { ...file, bytes: new Uint8Array(64 * 1024 + 1).fill(65) }
        : file,
    );
    await code("packageTooLarge", () => verifySkillResources(value.raw, oversized));
    const invalid = value.resources.map((file) =>
      file.path === value.manifest.skills[0].instructions ? { ...file, bytes: new Uint8Array([0xc0, 0x80]) } : file,
    );
    await code("invalidResource", () => verifySkillResources(value.raw, invalid));
  });
  test("compatible versions are numerical, bounded and independent of engine protocol", async () => {
    const value = await pack((m) => {
      m.requires.pandaForce = { min: "0.0.9", maxExclusive: "0.0.15" };
    });
    assertSkillCompatibility(value.manifest, "0.0.14");
    await code("incompatibleVersion", () => assertSkillCompatibility(value.manifest, "0.0.15"));
    await code("incompatibleVersion", () =>
      pack((m) => {
        m.requires.skillApi = 2;
      }),
    );
    await code("invalidIdentity", () =>
      pack((m) => {
        m.version = "01.2.3";
      }),
    );
    await code("invalidManifest", () =>
      pack((m) => {
        m.requires.pandaForce = { min: "0.2.0", maxExclusive: "0.1.0" };
      }),
    );
  });
  test("admission budgets count actual bytes before parsing or hashing resources", async () => {
    const value = fixture();
    await code("packageTooLarge", () => verifySkillResources(new Uint8Array(256 * 1024 + 1), value.resources));
    const large = new Uint8Array(4 * 1024 * 1024).fill(65);
    const files = Array.from({ length: 9 }, (_, index) => ({ path: `data/file-${index}.json`, bytes: large }));
    value.manifest.files.push(...files.map((file) => file.path));
    await code("packageTooLarge", () =>
      verifySkillResources(new TextEncoder().encode(JSON.stringify(value.manifest)), [...value.resources, ...files]),
    );
    const multibyte = fixture();
    const instruction = multibyte.manifest.skills[0].instructions;
    await code("packageTooLarge", () =>
      verifySkillResources(
        multibyte.raw,
        multibyte.resources.map((file) =>
          file.path === instruction ? { ...file, bytes: new TextEncoder().encode("\u4e2d".repeat(32768)) } : file,
        ),
      ),
    );
  });
  test("all catalog copy requires English fallback and locale aliases cannot collide", async () => {
    await code("invalidManifest", () =>
      pack((m) => {
        delete m.name.en;
      }),
    );
    await code("invalidManifest", () =>
      pack((m) => {
        m.name["en-US"] = "US";
        m.name["en-us"] = "Alias";
      }),
    );
    const value = await pack((m) => {
      m.name["en-us"] = "US";
    });
    expect(value.manifest.name["en-US"]).toBe("US");
  });
  test("a single-skill package and multiline descriptions remain valid without enabling other exports", async () => {
    const value = await pack((manifest) => {
      manifest.skills = [manifest.skills[0]];
      manifest.description.en = "A clear workflow.\nA second paragraph.";
    });
    expect(value.manifest.skills.length).toBe(1);
    expect(composeSkills([chosen(value, "writing")], authority).skills.length).toBe(1);
    await code("invalidManifest", () =>
      pack((manifest) => {
        manifest.skills[1].id = "writing";
      }),
    );
  });
});

describe("ordered skills are data, not permission or persistence", () => {
  test("same-package exports preserve user order, isolated parameters and immutable source identities", async () => {
    const value = await pack((m) => {
      m.skills[2].parameters = [{ id: "audience", type: "text", label: { en: "Audience" }, required: true }];
    });
    const compiled = composeSkills(
      [
        chosen(value, "writing"),
        chosen(value, "brand-voice", { audience: "Customers" }),
        chosen(value, "blog-outline", { audience: "Developers" }),
      ],
      authority,
    );
    expect(compiled.skills.map((skill) => skill.id)).toEqual(["writing", "brand-voice", "blog-outline"]);
    expect(compiled.skills[1]!.parameters.audience).toBe("Customers");
    expect(compiled.skills[2]!.parameters.audience).toBe("Developers");
    expect(compiled.skills[2]!.template).toContain("#");
    expect(compiled.skills.every((skill) => skill.digest === value.digest && skill.version === "1.0.0")).toBe(true);
    expect(Object.isFrozen(compiled.skills[2]!.parameters)).toBe(true);
    expect(Object.isFrozen(compiled.skills)).toBe(true);
    expect(compiled.capabilities).toEqual([
      "project.documents.read",
      "project.documents.create",
      "project.documents.propose-update",
    ]);
  });
  test("exactly one workflow and one instance of each qualified export are required", async () => {
    const value = await pack();
    await code("workflowRequired", () => composeSkills([chosen(value, "brand-voice")], authority));
    await code("duplicateSkill", () => composeSkills([chosen(value, "writing"), chosen(value, "writing")], authority));
    const other = await pack((m) => {
      m.id = "another.writing-kit";
    });
    await code("workflowRequired", () =>
      composeSkills([chosen(value, "writing"), chosen(other, "writing")], authority),
    );
  });
  test("one-sided declared incompatibility is enforced in both selection orders", async () => {
    const value = await pack((m) => {
      m.skills[2].composition.conflictsWith = [m.id + "/writing"];
    });
    for (const ids of [
      ["writing", "brand-voice"],
      ["brand-voice", "writing"],
    ])
      await code("conflictingSkills", () =>
        composeSkills(
          ids.map((id) => chosen(value, id)),
          authority,
        ),
      );
  });
  test("hard constraint conflicts never silently use the last selected style", async () => {
    const value = await pack((m) => {
      m.skills[0].composition.constraints = { outputLocale: "en" };
      m.skills[2].composition.constraints = { outputLocale: "zh-CN" };
    });
    await code("conflictingConstraints", () =>
      composeSkills([chosen(value, "writing"), chosen(value, "brand-voice")], authority),
    );
    const equal = await pack((m) => {
      m.skills[0].composition.constraints = { outputLocale: "en-us" };
      m.skills[2].composition.constraints = { outputLocale: "en-US" };
    });
    expect(composeSkills([chosen(equal, "writing"), chosen(equal, "brand-voice")], authority).constraints).toEqual({
      outputLocale: "en-US",
    });
  });
  test("missing tool capabilities or user grants cannot become successful reduced tasks", async () => {
    const value = await pack(),
      selected = [chosen(value, "writing")];
    await code("capabilityUnavailable", () => composeSkills(selected, { ...authority, available: new Set() }));
    await code("capabilityUnavailable", () => composeSkills(selected, { ...authority, granted: new Set() }));
    await code("incompatibleOutput", () => composeSkills(selected, { ...authority, outputType: "image" }));
  });
  test("third-party entitlement declarations require an independently supplied grant", async () => {
    const value = await pack((m) => {
      m.skills[2].entitlement = { issuer: "https://example.com", product: "brand-style" };
    });
    const selected = [chosen(value, "writing"), chosen(value, "brand-voice")];
    await code("entitlementRequired", () => composeSkills(selected, authority));
    expect(
      composeSkills(selected, { ...authority, entitled: new Set([value.digest + "/brand-voice"]) }).skills.length,
    ).toBe(2);
    expect(composeSkills([chosen(value, "writing")], authority).skills.length).toBe(1);
  });
  test("parameters validate missing, extra, finite range, choice and boolean values", async () => {
    const value = await pack((m) => {
      m.skills[1].parameters = [
        { id: "count", type: "number", minimum: 1, maximum: 3, label: { en: "Count" }, required: true },
        { id: "enabled", type: "boolean", label: { en: "Enabled" }, required: true },
        {
          id: "tone",
          type: "choice",
          label: { en: "Tone" },
          required: true,
          options: [{ value: "clear", label: { en: "Clear" } }],
        },
      ];
    });
    const compile = (parameters: unknown) =>
      composeSkills([chosen(value, "writing"), chosen(value, "blog-outline", parameters)], authority);
    for (const parameters of [
      {},
      { count: Infinity, enabled: true, tone: "clear" },
      { count: 4, enabled: true, tone: "clear" },
      { count: 2, enabled: "yes", tone: "clear" },
      { count: 2, enabled: true, tone: "other" },
    ])
      await code("invalidParameters", () => compile(parameters));
    expect(compile({ count: 2, enabled: false, tone: "clear" }).skills[1]!.parameters.enabled).toBe(false);
    await code("invalidParameters", () => compile({ count: 2, enabled: false, tone: "clear", secret: "not declared" }));
  });
  test("instructions and templates share one bounded task budget", async () => {
    const value = fixture((m) => {
      m.skills[1].template = "templates/blog-outline.md";
    });
    const resources = value.resources.map((file) =>
      file.path === "templates/blog-outline.md" ? { ...file, bytes: new Uint8Array(256 * 1024).fill(65) } : file,
    );
    const verified = await verifySkillResources(value.raw, resources);
    await code("packageTooLarge", () =>
      composeSkills([chosen(verified, "writing"), chosen(verified, "blog-outline")], authority),
    );
  });
});
