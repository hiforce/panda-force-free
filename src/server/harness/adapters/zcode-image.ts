import { createDecipheriv, createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { isRecord } from "../../../shared/records.js";
import type { ApplicationImageRenderer } from "../../engines/application-tools/runtime-port.js";

const origin = "https://zcode.z.ai";
const pluginVersion = "0.1.2";
const maxReferenceBytes = 10 * 1024 * 1024;
const reviewedSha256 = "583ac893030ec05fbf54f77dcb2dc39d4e321afb155ba24c62d151ae4186adce";
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest();

async function privateFile(path: string, limit: number) {
  if ((await realpath(path)) !== path) throw Error("ZCode image credentials unavailable");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o077) !== 0)
      throw Error("ZCode image credentials unavailable");
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw Error("ZCode image credentials changed");
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function credential(value: unknown, key: Buffer) {
  if (typeof value !== "string") throw Error("ZCode image credentials unavailable");
  const prefix = "enc:v2:env:" + hash(key).toString("hex").slice(0, 24) + ":";
  if (!value.startsWith(prefix)) throw Error("ZCode image credentials unavailable");
  const parts = value.slice(prefix.length).split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[a-z\d_-]+$/i.test(part)))
    throw Error("ZCode image credentials unavailable");
  const [iv, tag, bytes] = parts.map((part) => Buffer.from(part, "base64url"));
  if (iv!.length !== 12 || tag!.length !== 16) throw Error("ZCode image credentials unavailable");
  const decipher = createDecipheriv("aes-256-gcm", key, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(bytes!), decipher.final()]).toString("utf8");
}

async function officialHeaders(home: string) {
  const directory = join(home, "zcode", ".zcode", "v2");
  const [secret, encrypted] = await Promise.all([
    privateFile(join(directory, "credential-secret"), 4096),
    privateFile(join(directory, "credentials.json"), 262144),
  ]);
  if (secret.length < 32) throw Error("ZCode image credentials unavailable");
  const values: unknown = JSON.parse(encrypted.toString("utf8"));
  if (!isRecord(values)) throw Error("ZCode image credentials unavailable");
  const key = hash(secret);
  if (credential(values["oauth:active_provider"], key) !== "bigmodel")
    throw Error("An individual BigModel browser login is required");
  const bearer = (name: string) => {
    const value = credential(values[name], key);
    if (!/^[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+$/i.test(value)) throw Error("ZCode image credentials unavailable");
    return "Bearer " + value;
  };
  return {
    Authorization: bearer("zcodejwttoken"),
    "X-Bigmodel-Authorization": bearer("oauth:bigmodel:access_token"),
    "Bigmodel-Target-Type": "PERSONAL",
  };
}

function invokePlugin(script: string, cwd: string, input: string, signal: AbortSignal) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn("node", [script], {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, ZCODE_PROJECT_DIR: cwd, ZCODE_BASE_URL: origin },
      stdio: ["pipe", "pipe", "ignore"],
      signal,
      timeout: 335000,
      killSignal: "SIGKILL",
    });
    let size = 0;
    const chunks: Buffer[] = [];
    child.stdin.on("error", reject);
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32768) {
        child.kill("SIGKILL");
        reject(Error("ZCode image response exceeded the limit"));
      } else {
        chunks.push(chunk);
      }
    });
    child.on("close", (code) => {
      if (code !== 0) return reject(Error("ZCode image plugin did not complete"));
      try {
        const result = Buffer.concat(chunks)
          .toString("utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line): unknown => JSON.parse(line))
          .find((item) => isRecord(item) && item.id === 2);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

export function zcodeImageRenderer(accountHome: string): ApplicationImageRenderer {
  return {
    provider: "zcode",
    maxReferences: 1,
    maxReferenceBytes,
    async render(prompt, references, signal) {
      signal.throwIfAborted();
      const reference = references[0];
      if (references.length > 1 || (reference && reference.bytes.length > maxReferenceBytes))
        throw Error("Invalid ZCode image input");
      const home = await lstat(accountHome);
      if (
        !home.isDirectory() ||
        (home.mode & 0o077) !== 0 ||
        normalize(accountHome) !== accountHome ||
        (await realpath(accountHome)) !== accountHome
      )
        throw Error("ZCode image account directory unavailable");
      const script = join(
        accountHome,
        ".zcode",
        "cli",
        "plugins",
        "cache",
        "zcode-plugins-official",
        "image-generation",
        pluginVersion,
        "mcp",
        "server.mjs",
      );
      const plugin = await lstat(script);
      if (
        !plugin.isFile() ||
        plugin.size > 131072 ||
        (await realpath(script)) !== script ||
        hash(await readFile(script)).toString("hex") !== reviewedSha256
      )
        throw Error("Reviewed ZCode image plugin is unavailable");
      const headers = await officialHeaders(accountHome);
      const directory = await mkdtemp(join(tmpdir(), "panda-zcode-image-"));
      try {
        const arguments_ = {
          prompt,
          output_path: "image.png",
          ...(reference
            ? { reference_image: `data:${reference.mime};base64,${Buffer.from(reference.bytes).toString("base64")}` }
            : {}),
        };
        const call = {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "generate_image",
            arguments: arguments_,
            _meta: { "com.zcode/official-mcp-auth": { ok: true, headers } },
          },
        };
        const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } };
        const response = await invokePlugin(
          script,
          directory,
          JSON.stringify(init) + "\n" + JSON.stringify(call) + "\n",
          signal,
        );
        signal.throwIfAborted();
        const result = isRecord(response) ? response.result : null;
        const output = isRecord(result) && result.isError !== true ? result.structuredContent : null;
        const path = isRecord(output) && typeof output.path === "string" ? output.path : "";
        const file = /^image\.(?:png|jpe?g|webp)$/i.test(path) ? join(directory, path) : path;
        if (!file.startsWith(directory + "/") || !/^image\.(?:png|jpe?g|webp)$/i.test(file.slice(directory.length + 1)))
          throw Error("ZCode image plugin did not return an original");
        const info = await lstat(file);
        if (!info.isFile() || info.size > 32 * 1024 * 1024 || (await realpath(file)) !== file)
          throw Error("ZCode image plugin returned an invalid original");
        const id =
          isRecord(output) &&
          typeof output.invocation_id === "string" &&
          /^[a-z\d_-]{1,160}$/i.test(output.invocation_id)
            ? output.invocation_id
            : undefined;
        return { bytes: await readFile(file), invocationId: id };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
