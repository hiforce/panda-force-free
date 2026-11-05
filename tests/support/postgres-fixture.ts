import { SQL } from "bun";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, existsSync, readdirSync, chownSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/** Always creates a disposable local database; application database URLs are never used. */
export async function createPostgresFixture() {
  const parent = "/usr/lib/postgresql";
  const discovered = existsSync(parent)
    ? readdirSync(parent)
        .map((version) => join(parent, version, "bin"))
        .find((path) => existsSync(join(path, "initdb")))
    : undefined;
  const bin = process.env.PANDA_FORCE_TEST_PG_BIN || discovered;
  let child: ChildProcess | undefined, container: string | undefined, directory: string | undefined;
  let url: string;
  async function dispose() {
    if (child) {
      const running = child;
      if (running.exitCode === null && running.signalCode === null) {
        running.kill("SIGTERM");
        await new Promise<void>((resolve) => running.once("exit", () => resolve()));
      }
      child = undefined;
    }
    if (container) {
      execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      container = undefined;
    }
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  }
  try {
    if (bin) {
      // Disposable database files should not contend with production volumes during CI.
      let dataRoot = tmpdir();
      if (existsSync("/dev/shm")) {
        const memory = statfsSync("/dev/shm");
        if (memory.bavail * memory.bsize >= 40 * 1024 * 1024) dataRoot = "/dev/shm";
      }
      directory = mkdtempSync(join(dataRoot, "panda-postgres-test-"));
      const root = process.getuid?.() === 0;
      const identity = root ? { uid: 65534, gid: 65534 } : {};
      if (root) chownSync(directory, 65534, 65534);
      execFileSync(
        join(bin, "initdb"),
        [
          "-D",
          join(directory, "data"),
          "--username=panda",
          "--auth=trust",
          "--no-locale",
          "--encoding=UTF8",
          "--no-sync",
          "--wal-segsize=1",
        ],
        { ...identity, stdio: ["ignore", "ignore", "pipe"], timeout: 20_000 },
      );
      const port = await new Promise<number>((resolve, reject) => {
        const socket = createServer();
        socket.once("error", reject);
        socket.listen(0, "127.0.0.1", () => {
          const address = socket.address();
          if (!address || typeof address === "string") throw new Error("Missing database port");
          socket.close(() => resolve(address.port));
        });
      });
      child = spawn(
        join(bin, "postgres"),
        [
          "-D",
          join(directory, "data"),
          "-h",
          "127.0.0.1",
          "-p",
          String(port),
          "-k",
          directory,
          "-c",
          "min_wal_size=2MB",
          "-c",
          "max_wal_size=32MB",
        ],
        { ...identity, stdio: "ignore" },
      );
      url = `postgres://panda@127.0.0.1:${port}/postgres`;
    } else {
      container = "panda-postgres-test-" + randomUUID();
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-d",
          "--name",
          container,
          "--tmpfs",
          "/var/lib/postgresql:rw,size=128m",
          "--tmpfs",
          "/var/lib/postgresql/data:rw,size=128m",
          "-e",
          "POSTGRES_INITDB_ARGS=--no-sync --wal-segsize=1",
          "-e",
          "POSTGRES_USER=panda",
          "-e",
          "POSTGRES_DB=panda_test",
          "-e",
          "POSTGRES_HOST_AUTH_METHOD=trust",
          "-p",
          "127.0.0.1::5432",
          "postgres@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b",
          "postgres",
          "-c",
          "min_wal_size=2MB",
          "-c",
          "max_wal_size=32MB",
        ],
        { stdio: "ignore", timeout: 30_000 },
      );
      const address = execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).trim();
      url = `postgres://panda@${address}/panda_test`;
    }
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      const sql = new SQL(url, { connectionTimeout: 1, max: 1 });
      try {
        await sql.unsafe("SELECT 1");
        await sql.close();
        return { url, dispose };
      } catch {
        await sql.close();
        await Bun.sleep(100);
      }
    }
    throw new Error("Disposable PostgreSQL did not become ready");
  } catch (error) {
    await dispose();
    throw error;
  }
}
