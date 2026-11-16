import { expect, test } from "bun:test";
import { sftpInput } from "../../src/server/connections/adapters/sftp-input.js";
import { sftpPublicationFixture } from "../support/sftp-publication-fixture.js";

// This fixture uses only a private temporary filesystem; no external server is contacted.
test("SFTP accepts domain and Unicode directory names while preserving a canonical target identity", async () => {
  const f = await sftpPublicationFixture("/sites/docs.example.test/中文 handbook");
  try {
    expect(sftpInput(f.input).directory).toBe(f.input.directory);
    const record = await f.prepare();
    expect(record.plan.servedPath).toContain("/sites/docs.example.test/%E4%B8%AD%E6%96%87%20handbook/current");
    await f.service.publish(f.owner, record.plan.id, record.plan.fingerprint);
    await f.run();
    expect(f.store.get(record.plan.id).job.phase).toBe("published");
    expect(await f.files.readlink(f.input.directory + "/current")).toBe(`releases/${record.plan.id}/site`);
    const bytes = await f.files.read(f.input.directory + `/releases/${record.plan.id}/site/index.html`, 1024);
    expect(new TextDecoder().decode(bytes)).toBe(f.content);
    for (const directory of [
      "/",
      "/a/",
      "/a//b",
      "/a/./b",
      "/a/../b",
      "/a\\b",
      "/a\nb",
      "/a\u202eb",
      "/a\ud800b",
      "/a ",
      " /a",
      "/" + "中".repeat(86),
    ])
      expect(() => sftpInput({ ...f.input, directory })).toThrow("invalidPath");
    // An encoded-looking name is a literal filesystem segment, never decoded as traversal.
    expect(sftpInput({ ...f.input, directory: "/a/%2e%2e/b" }).directory).toBe("/a/%2e%2e/b");
  } finally {
    f.dispose();
  }
}, 15000);
