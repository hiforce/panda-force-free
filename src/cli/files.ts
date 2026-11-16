import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CliError } from "../shared/cli/contracts.js";
export async function readPrivateJson(path: string, secret = false): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 32768 || (secret && process.platform !== "win32" && (info.mode & 0o077) !== 0))
      throw new CliError("authenticationRequired", 401);
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
export async function assertPrivateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0))
    throw new CliError("authenticationRequired", 401);
  if (process.getuid && info.uid !== process.getuid()) throw new CliError("authenticationRequired", 401);
}
export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(path);
}
export async function writePrivateJson(path: string, value: unknown) {
  await privateDirectory(dirname(path));
  const temp = join(dirname(path), ".panda-" + randomUUID()),
    file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
    const dir = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}
