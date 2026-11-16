import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { BuildError } from "../shared/builds/errors.js";
import { RESOURCE_FRAME_MAX } from "../shared/builds/resource-frame.js";

/** Disk corruption or replacement cannot turn a retained native input into an unbounded allocation. */
export function readResourceFile(path: string): Uint8Array {
  const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.size > RESOURCE_FRAME_MAX || stat.size < 16)
      throw new BuildError("invalidResourceBuild");
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(handle, bytes, offset, bytes.length - offset, null);
      if (!read) throw new BuildError("invalidResourceBuild");
      offset += read;
    }
    if (readSync(handle, new Uint8Array(1), 0, 1, null)) throw new BuildError("invalidResourceBuild");
    return bytes;
  } finally {
    closeSync(handle);
  }
}
