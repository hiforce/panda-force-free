import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { S3Connection, S3Credentials } from "../../src/server/object-storage/contracts.js";
import { signS3Headers } from "../../src/server/object-storage/sigv4.js";

/** Only an explicitly configured disposable image is used; no live S3 service or configured application bucket is read. */
export async function objectStorageFixture() {
  const image = process.env.PANDA_FORCE_TEST_MINIO_IMAGE;
  if (!image) return null;
  if (process.env.DOCKER_HOST && process.env.DOCKER_HOST !== "unix:///var/run/docker.sock")
    throw new Error("Owned S3 fixtures require the local Docker daemon");
  const binary = process.env.PANDA_FORCE_TEST_MINIO_BINARY;
  if (binary && (!isAbsolute(binary) || binary.includes(","))) throw new Error("Invalid fixture binary path");
  const directory = await mkdtemp(join(tmpdir(), "panda-owned-object-store-")),
    name = "panda-owned-object-store-" + randomUUID(),
    credentials: S3Credentials = {
      accessKeyId: "fixture" + randomBytes(8).toString("hex"),
      secretAccessKey: randomBytes(32).toString("hex"),
    };
  async function docker(args: string[]) {
    const result = Bun.spawn(["docker", "--host=unix:///var/run/docker.sock", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(result.stdout).text(),
      new Response(result.stderr).text(),
      result.exited,
    ]);
    if (code) throw new Error("Owned S3 fixture command failed: " + stderr.slice(-2048));
    return stdout.trim();
  }
  const close = async () => {
    try {
      await docker(["rm", "-f", name]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    const env = join(directory, "fixture.env");
    await writeFile(
      env,
      `MINIO_ROOT_USER=${credentials.accessKeyId}\nMINIO_ROOT_PASSWORD=${credentials.secretAccessKey}\nMINIO_BROWSER=off\nMINIO_UPDATE=off\nHOME=/tmp\n`,
      { flag: "wx", mode: 0o600 },
    );
    await docker([
      "run",
      "--detach",
      "--name",
      name,
      "--pull=never",
      "--read-only",
      "--user=1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory=512m",
      "--cpus=1",
      "--pids-limit=128",
      "--tmpfs=/data:uid=1000,gid=1000,mode=0700,size=256m",
      "--tmpfs=/tmp:mode=1777,size=64m",
      "--env-file",
      env,
      "-p",
      "127.0.0.1::9000",
      ...(binary
        ? ["--mount", `type=bind,src=${binary},dst=/proof/minio,readonly`, "--entrypoint", "/proof/minio"]
        : []),
      image,
      "server",
      "/data",
      "--address=:9000",
      "--console-address=127.0.0.1:9001",
    ]);
    const port = await docker(["port", name, "9000/tcp"]);
    if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new Error("Fixture is not loopback-only");
    const endpoint = "http://" + port;
    const deadline = Date.now() + 20000;
    while (true) {
      try {
        if ((await fetch(endpoint + "/minio/health/ready", { signal: AbortSignal.timeout(500) })).ok) break;
      } catch {
        /* The owned process may still be starting. */
      }
      if (Date.now() >= deadline) throw new Error("Owned S3 fixture readiness timed out");
      await Bun.sleep(50);
    }
    const connection = (bucket: string): S3Connection => ({
      endpoint,
      bucket,
      region: "us-east-1",
      forcePathStyle: true,
    });
    const request = async (
      method: string,
      path: string,
      bytes = new Uint8Array(),
      headers: Record<string, string> = {},
    ) => {
      const url = new URL(path, endpoint),
        body = new Uint8Array(bytes);
      return fetch(url, {
        method,
        headers: signS3Headers({ method, url, region: "us-east-1", credentials, payload: body, headers }),
        body: ["PUT", "POST"].includes(method) ? body : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
    };
    return {
      credentials,
      connection,
      request,
      endpoint,
      close,
      fixture: {
        container: name,
        image,
        loopbackOnly: true,
        memoryMiB: 512,
        cpus: 1,
        nonroot: true,
        readonlyRoot: true,
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
