import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import { HarnessError } from "../../../shared/harness/contracts.js";
import type { HarnessRemoteAcpConnection } from "../adapters/stdio.js";

async function mountedValue(path: string, maxBytes: number, secret = false) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || !info.size || info.size > maxBytes || (secret && (info.mode & 0o037) !== 0)) throw Error();
      const bytes = Buffer.alloc(maxBytes + 1);
      try {
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== info.size) throw Error();
        return bytes.subarray(0, bytesRead).toString("utf8");
      } finally {
        if (secret) bytes.fill(0);
      }
    } finally {
      await file.close();
    }
  } catch {
    throw new HarnessError(secret ? "authentication" : "unavailable", 503);
  }
}

export function remoteAcpEndpoint(baseUrl: unknown) {
  try {
    if (typeof baseUrl !== "string" || baseUrl.length > 2048) throw Error();
    const endpoint = new URL(baseUrl);
    if (
      !["https:", "wss:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw Error();
    endpoint.protocol = "wss:";
    return endpoint;
  } catch {
    throw new HarnessError("invalidInput");
  }
}

/** Only an operator profile may choose the destination, remote workspace and mounted trust inputs. */
export function remoteAcpLaunch(profile: Record<string, unknown>) {
  const remoteEndpoint = remoteAcpEndpoint(profile.baseUrl);
  const { apiKeyFile, certificateAuthorityFile, remoteWorkspace } = profile;
  if (
    typeof apiKeyFile !== "string" ||
    !isAbsolute(apiKeyFile) ||
    (certificateAuthorityFile !== undefined &&
      (typeof certificateAuthorityFile !== "string" || !isAbsolute(certificateAuthorityFile))) ||
    typeof remoteWorkspace !== "string" ||
    remoteWorkspace.length > 1024 ||
    !posix.isAbsolute(remoteWorkspace) ||
    remoteWorkspace === "/" ||
    posix.normalize(remoteWorkspace) !== remoteWorkspace ||
    [...remoteWorkspace].some((char) => char.charCodeAt(0) < 32)
  )
    throw new HarnessError("invalidInput");
  return async (cwd: string): Promise<HarnessRemoteAcpConnection> => {
    const apiKey = (await mountedValue(apiKeyFile, 4096, true)).trim();
    if (!/^[\x21-\x7e]+$/.test(apiKey)) throw new HarnessError("authentication", 503);
    return {
      cwd,
      remoteEndpoint,
      remoteWorkspace,
      apiKey,
      ...(certificateAuthorityFile
        ? { certificateAuthority: await mountedValue(certificateAuthorityFile, 256 * 1024) }
        : {}),
    };
  };
}
