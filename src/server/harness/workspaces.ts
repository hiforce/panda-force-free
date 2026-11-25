import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export async function createHarnessWorkspace(root: string, prefix: string, hostSocket = false) {
  let cwd: string;
  if (hostSocket) {
    // Group permissions also bound inherited POSIX ACL entries for the host user.
    const sharedMode = (await stat(root)).mode & 0o070;
    cwd = join(root, prefix + randomUUID());
    await mkdir(cwd, { mode: 0o700 | sharedMode });
  } else cwd = await mkdtemp(join(root, prefix));
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
