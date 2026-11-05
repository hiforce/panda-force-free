import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { reportDiagnostic } from "../../shared/diagnostics.js";

// Unique segments avoid concurrent renames when old and new Pods briefly overlap.
// Retention applies to the entire app log directory, across restarts and Pods.
const SEGMENT = /^panda-force-\d{17}-[a-f0-9]{32}\.log$/;
const LINK = "panda-force.log";

function missing(error) {
  return error.code === "ENOENT";
}

export function createRotatingLog({ directory, maxFileBytes, maxFiles, now = () => new Date() }) {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 4 || !Number.isSafeInteger(maxFiles) || maxFiles < 1)
    throw new Error("Invalid PandaForce log rotation limits");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const alias = join(directory, LINK);
  try {
    if (!lstatSync(alias).isSymbolicLink() || !SEGMENT.test(readlinkSync(alias)))
      throw new Error(`${alias} must be a PandaForce-managed log link`);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  let current = null,
    size = 0;

  function prune() {
    const segments = readdirSync(directory)
      .filter((name) => SEGMENT.test(name))
      .sort()
      .filter((name) => {
        try {
          const info = lstatSync(join(directory, name));
          if (!info.isFile()) throw new Error(`Unexpected log segment type: ${name}`);
          // Applying a smaller size limit also retires oversized old segments.
          if (name !== current && info.size > maxFileBytes) {
            unlinkSync(join(directory, name));
            return false;
          }
          return true;
        } catch (error) {
          if (!missing(error)) throw error;
          return false;
        }
      });
    // Always keep this writer's current segment, even if the system clock changed.
    const others = segments.filter((name) => name !== current);
    for (const name of others.slice(0, Math.max(0, others.length - maxFiles + 1))) {
      const path = join(directory, name);
      try {
        if (!lstatSync(path).isFile()) throw new Error(`Unexpected log segment type: ${name}`);
        unlinkSync(path);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }

  function publishCurrent() {
    try {
      if (readlinkSync(alias) === current) return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const temporary = join(directory, `.panda-force-current-${randomUUID()}`);
    try {
      symlinkSync(current, temporary);
      renameSync(temporary, alias);
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!missing(error)) reportDiagnostic("logs.cleanup", error);
      }
    }
  }

  function rotate() {
    const stamp = now()
      .toISOString()
      .replace(/[-:TZ.]/g, "");
    current = `panda-force-${stamp}-${randomUUID().replaceAll("-", "")}.log`;
    const fd = openSync(join(directory, current), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    closeSync(fd);
    size = 0;
    publishCurrent();
    prune();
  }

  function write(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < bytes.length) {
      // A different writer may have pruned a quiet segment during a rollout.
      try {
        const path = join(directory, current);
        if (!lstatSync(path).isFile()) throw new Error("Invalid active log segment");
        size = statSync(path).size;
      } catch (error) {
        if (!missing(error)) throw error;
        rotate();
      }
      if (size && size + bytes.length - offset > maxFileBytes) rotate();
      let end = Math.min(offset + maxFileBytes - size, bytes.length);
      // Keep UTF-8 characters together at segment boundaries.
      while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end--;
      if (end === offset) {
        rotate();
        continue;
      }
      let fd;
      try {
        fd = openSync(join(directory, current), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      } catch (error) {
        if (!missing(error)) throw error;
        rotate();
        continue;
      }
      try {
        let position = offset;
        while (position < end) position += writeSync(fd, bytes, position, end - position);
      } finally {
        closeSync(fd);
      }
      size += end - offset;
      offset = end;
    }
    // A quiet overlapping writer can retain its segment after another writer moved the alias.
    if (bytes.length) publishCurrent();
  }

  rotate();
  return {
    write,
    get currentFile() {
      return join(directory, current);
    },
  };
}
