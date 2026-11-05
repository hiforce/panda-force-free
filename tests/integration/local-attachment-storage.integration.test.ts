import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localAuthFixture } from "../support/local-auth-fixture.mjs";
import { buildComposerInput } from "../../src/client/composer-attachments.js";

test("local uploads use the configured persistent root and native input keeps the original filename", async () => {
  const uploads = mkdtempSync(join(tmpdir(), "panda-uploads-"));
  // Outside /tmp and HOME: the old upload directory needs its own read boundary.
  const legacyHome = mkdtempSync(new URL("../../.artifacts/legacy-attachment-", import.meta.url).pathname);
  const fixture = await localAuthFixture();
  try {
    fixture.env.CODEX_HOME = legacyHome;
    fixture.env.PANDA_FORCE_ATTACHMENT_ROOT = uploads;
    // Credentials alone must not enable OSS or cause any cloud request.
    fixture.env.PANDA_FORCE_OSS_BUCKET = "unused-bucket";
    fixture.env.PANDA_FORCE_OSS_ACCESS_KEY_ID = "unused-id";
    fixture.env.PANDA_FORCE_OSS_ACCESS_KEY_SECRET = "unused-secret";
    await fixture.restart();
    const setup = await fixture.post("/api/auth/setup", { username: "owner", password: "Abc123" });
    expect(setup.status).toBe(200);
    let cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const config = await (await fetch(fixture.base + "/api/config", { headers: { cookie } })).json();
    expect(config).toMatchObject({ attachmentStorage: "local", attachmentUrlPrefix: null });
    const png = readFileSync(new URL("../../public/assets/panda-icon.png", import.meta.url));
    const oldRoot = join(legacyHome, "panda-force-uploads");
    mkdirSync(oldRoot);
    const oldImage = join(oldRoot, "old-image.png");
    const oldFile = join(oldRoot, "old-notes.txt");
    writeFileSync(oldImage, png);
    writeFileSync(oldFile, "Historical attachment");
    const name = "我的原图 01.png";
    const upload = await fetch(fixture.base + "/api/attachments?name=" + encodeURIComponent(name), {
      method: "POST",
      headers: { cookie, "content-type": "application/octet-stream" },
      body: png,
    });
    expect(upload.status).toBe(201);
    const { attachment } = await upload.json();
    expect(attachment.name).toBe(name);
    expect(attachment.url).toBeUndefined();
    expect(attachment.path).toBe(join(uploads, attachment.id, name));
    expect(statSync(attachment.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(attachment.path)).toEqual(png);
    expect(existsSync(join(fixture.dir, "panda-force-uploads"))).toBe(false);
    expect(buildComposerInput("Read 01", [attachment])).toContainEqual({ type: "localImage", path: attachment.path });
    const preview = await fetch(fixture.base + "/api/images/local?path=" + encodeURIComponent(attachment.path), {
      headers: { cookie },
    });
    expect(preview.status).toBe(200);
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(png);
    const oldPreview = await fetch(fixture.base + "/api/images/local?path=" + encodeURIComponent(oldImage), {
      headers: { cookie },
    });
    expect(oldPreview.status).toBe(200);
    expect(Buffer.from(await oldPreview.arrayBuffer())).toEqual(png);
    const oldDownload = await fetch(fixture.base + "/api/files/download?path=" + encodeURIComponent(oldFile), {
      headers: { cookie },
    });
    expect(oldDownload.status).toBe(200);
    expect(await oldDownload.text()).toBe("Historical attachment");
    await fixture.restart();
    expect((await (await fetch(fixture.base + "/api/auth/status")).json()).setupRequired).toBe(false);
    const login = await fixture.post("/api/auth/login", { username: "owner", password: "Abc123" });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect(
      (
        await fetch(fixture.base + "/api/images/local?path=" + encodeURIComponent(attachment.path), {
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
    // A separate process, like the native CLI, sees the same absolute path.
    const reader = Bun.spawnSync([
      process.execPath,
      "-e",
      "process.stdout.write(require('fs').readFileSync(process.argv[1]))",
      attachment.path,
    ]);
    expect(reader.exitCode).toBe(0);
    expect(Buffer.from(reader.stdout)).toEqual(png);
  } finally {
    await fixture.dispose();
    rmSync(uploads, { recursive: true, force: true });
    rmSync(legacyHome, { recursive: true, force: true });
  }
}, 20000);
