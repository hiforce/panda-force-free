import { expect, test } from "bun:test";
import { Client, type SFTPWrapper, type Stats } from "ssh2";
import { SftpFiles } from "../../src/server/remote-files/session.js";

test("transport timeouts close pending operations and reject future requests", async () => {
  const files = new SftpFiles(new Client(), { lstat: () => {} } as unknown as SFTPWrapper, 10, 1000);
  try {
    const results = await Promise.allSettled([files.stat("/first"), files.stat("/second")]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    for (const result of results) if (result.status === "rejected") expect(result.reason.message).toBe("disconnected");
    await expect(files.stat("/later")).rejects.toThrow("disconnected");
  } finally {
    files.close();
  }
});

test("transport accepts omitted directory size but rejects unbounded regular-file sizes", async () => {
  let regular = false;
  const files = new SftpFiles(new Client(), {
    lstat: (_path: string, done: (error: undefined, info: Stats) => void) =>
      done(undefined, {
        isDirectory: () => !regular,
        isFile: () => regular,
        isSymbolicLink: () => false,
      } as Stats),
  } as unknown as SFTPWrapper);
  try {
    expect((await files.stat("/directory"))?.size).toBe(0);
    regular = true;
    await expect(files.stat("/file")).rejects.toThrow("remoteLimit");
  } finally {
    files.close();
  }
});

test("directory streaming is capped and closes its handle when the peer never sends EOF", async () => {
  const handle = Buffer.from("fixture");
  let requests = 0,
    closed = false;
  const files = new SftpFiles(new Client(), {
    opendir: (_path: string, done: (error: undefined, value: Buffer) => void) => done(undefined, handle),
    readdir: (value: Buffer, done: (error: undefined, values: unknown[]) => void) => {
      expect(value).toBe(handle);
      requests++;
      done(undefined, []);
    },
    close: (value: Buffer, done: () => void) => {
      expect(value).toBe(handle);
      closed = true;
      done();
    },
  } as unknown as SFTPWrapper);
  try {
    await expect(files.list("/directory")).rejects.toThrow("remoteLimit");
    expect(requests).toBe(3000);
    expect(closed).toBe(true);
  } finally {
    files.close();
  }
});
