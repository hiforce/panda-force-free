import { closeSync, fsyncSync, openSync } from "node:fs";
import { open } from "node:fs/promises";

/** Publication receipts must not reach durable SQLite before the corresponding files and rename do. */
export function syncLocalPath(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function durableLocalFile(path: string, bytes: Uint8Array | string, mode: number) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function syncLocalDirectories(paths: Iterable<string>) {
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
