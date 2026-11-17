import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CreationAuthoredFileVersions } from "../../src/server/creation/integration/authored-file-versions.js";
import { CreationFileLocations } from "../../src/server/creation/integration/file-locations.js";
import { CreationFileRelocations } from "../../src/server/creation/integration/file-relocation.js";
import { authoredDigest } from "../../src/server/creation/integration/authored-file-version-records.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "creation-file-move-")),
    source = join(root, "source"),
    target = join(root, "docs"),
    state = join(root, "state"),
    owner = "owner",
    id = randomUUID(),
    conversationId = randomUUID();
  await mkdir(source);
  await mkdir(target);
  const versions = new CreationAuthoredFileVersions(join(state, "versions")),
    locations = new CreationFileLocations(join(state, "locations")),
    directory = { path: source, verify: async () => {} },
    destination = { path: target, identity: authoredDigest(target), verify: async () => {} },
    version = await versions.write(owner, id, directory, "requirements.md", "# Original source\n");
  await locations.advance(owner, conversationId, null, version);
  const plan = {
    schema: 1 as const,
    owner,
    taskId: id,
    outputDigest: authoredDigest("output"),
    directory: source,
    conversationId,
    filename: version.filename,
    previous: null,
    title: "Original source",
    markdown: "# Original source\n",
    images: [],
  };
  const options = { plan, version, source: directory, destination, versions, locations, images: async () => {} };
  return { root, source, target, state, options, close: () => rm(root, { recursive: true, force: true }) };
}
for (const phase of ["published", "taken", "removed", "located"] as const)
  test(`process exit after a file move is ${phase} resumes without duplicate Markdown or rollback of a later update`, async () => {
    const f = await fixture();
    try {
      const script = join(f.root, "crash.ts"),
        payload = join(f.root, "input.json"),
        base = new URL("../../src/server/creation/integration/", import.meta.url).pathname;
      await writeFile(
        payload,
        JSON.stringify({
          state: f.state,
          plan: f.options.plan,
          version: f.options.version,
          source: f.source,
          target: f.target,
          phase,
        }),
      );
      await writeFile(
        script,
        `import {readFile} from "node:fs/promises";\nimport {CreationAuthoredFileVersions} from ${JSON.stringify(base + "authored-file-versions.ts")};\nimport {CreationFileLocations} from ${JSON.stringify(base + "file-locations.ts")};\nimport {CreationFileRelocations} from ${JSON.stringify(base + "file-relocation.ts")};\nimport {authoredDigest} from ${JSON.stringify(base + "authored-file-version-records.ts")};\nconst f=JSON.parse(await readFile(process.argv[2],"utf8"));await new CreationFileRelocations(f.state+"/move",async(step)=>{if(step===f.phase)process.exit(73)}).commit({plan:f.plan,version:f.version,source:{path:f.source,verify:async()=>{}},destination:{path:f.target,identity:authoredDigest(f.target),verify:async()=>{}},versions:new CreationAuthoredFileVersions(f.state+"/versions"),locations:new CreationFileLocations(f.state+"/locations"),images:async()=>{}});\n`,
      );
      const child = Bun.spawn([process.execPath, script, payload], { stdout: "pipe", stderr: "pipe" });
      expect(await child.exited, await new Response(child.stderr).text()).toBe(73);
      const moves = new CreationFileRelocations(join(f.state, "move")),
        receipt = await moves.commit(f.options);
      expect((await readdir(f.source)).filter((name) => name.endsWith(".md"))).toHaveLength(0);
      expect(await readdir(f.target)).toEqual(["requirements.md"]);
      expect(await readFile(join(f.target, "requirements.md"), "utf8")).toBe(f.options.plan.markdown);
      expect((await f.options.locations.current("owner", f.options.plan.conversationId))?.directory).toBe(f.target);
      const later = await f.options.versions.write(
        "owner",
        randomUUID(),
        f.options.destination,
        "requirements.md",
        "# Later edit\n",
        receipt.id,
      );
      await f.options.locations.advance("owner", f.options.plan.conversationId, receipt.id, {
        ...later,
        directoryIdentity: f.options.destination.identity,
      });
      // A delayed receipt replay is read-only after the durable location handoff.
      await new CreationFileRelocations(join(f.state, "move")).commit(f.options);
      expect(await readFile(join(f.target, "requirements.md"), "utf8")).toBe("# Later edit\n");
      expect((await f.options.locations.current("owner", f.options.plan.conversationId))?.id).toBe(later.id);
    } finally {
      await f.close();
    }
  }, 30000);

test("a source edited or a grant revoked after publication remains at its original path and cannot complete the move", async () => {
  for (const changed of ["source", "grant"] as const) {
    const f = await fixture();
    let allowed = true;
    try {
      const options = {
        ...f.options,
        source: {
          path: f.source,
          verify: async () => {
            if (!allowed) throw Error("Revoked");
          },
        },
      };
      const move = new CreationFileRelocations(join(f.state, "move"), async (step) => {
        if (step !== "published") return;
        if (changed === "source") await writeFile(join(f.source, "requirements.md"), "User correction\n");
        else allowed = false;
      });
      await expect(move.commit(options)).rejects.toThrow();
      expect(await readFile(join(f.source, "requirements.md"), "utf8")).toBe(
        changed === "source" ? "User correction\n" : f.options.plan.markdown,
      );
      expect((await f.options.locations.current("owner", f.options.plan.conversationId))?.directory).toBe(f.source);
      expect(await readFile(join(f.target, "requirements.md"), "utf8")).toBe(f.options.plan.markdown);
    } finally {
      await f.close();
    }
  }
});

test("a new user file at the vacated source name survives completion of the original move", async () => {
  const f = await fixture();
  try {
    const path = join(f.source, "requirements.md"),
      moves = new CreationFileRelocations(join(f.state, "move"), async (phase) => {
        if (phase === "taken") await writeFile(path, "New user file at the vacated name\n", { flag: "wx" });
      });
    await moves.commit(f.options);
    expect(await readFile(path, "utf8")).toBe("New user file at the vacated name\n");
    expect(await readFile(join(f.target, "requirements.md"), "utf8")).toBe(f.options.plan.markdown);
    expect((await f.options.locations.current("owner", f.options.plan.conversationId))?.directory).toBe(f.target);
  } finally {
    await f.close();
  }
});
