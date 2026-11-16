import { CLI_CAPABILITIES, CliError, cliId, cliText } from "../../../shared/cli/contracts.js";
import type { CliClientRecord, CliKeyRecord } from "./ports.js";

const time = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const optionalTime = (value: unknown) => value === null || time(value);
export function storedCliClient(row: CliClientRecord): CliClientRecord {
  try {
    cliId(row.id);
    cliText(row.owner, 1024);
    cliText(row.name, 80);
    if (!["codex", "claude", "cli"].includes(row.kind) || !time(row.createdAt) || !optionalTime(row.revokedAt))
      throw Error("Invalid client record");
    return row;
  } catch {
    throw new CliError("unavailable", 503);
  }
}
/** Corrupt durable grants fail closed instead of being treated as a partially valid permission set. */
export function storedCliKey(row: Record<string, unknown>): CliKeyRecord {
  try {
    const projects: unknown = JSON.parse(String(row.projects)),
      capabilities: unknown = JSON.parse(String(row.capabilities));
    cliId(row.clientId);
    cliText(row.owner, 1024);
    if (
      typeof row.keyId !== "string" ||
      !/^[a-f0-9]{24}$/.test(row.keyId) ||
      typeof row.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.digest) ||
      !Array.isArray(projects) ||
      !projects.length ||
      projects.length > 64 ||
      projects.some((project) => cliId(project) !== project) ||
      new Set(projects).size !== projects.length ||
      !Array.isArray(capabilities) ||
      !capabilities.length ||
      capabilities.length > CLI_CAPABILITIES.length ||
      capabilities.some((capability) => !CLI_CAPABILITIES.includes(capability)) ||
      new Set(capabilities).size !== capabilities.length ||
      !time(row.createdAt) ||
      !time(row.expiresAt) ||
      !optionalTime(row.revokedAt) ||
      !optionalTime(row.lastUsedAt)
    )
      throw Error("Invalid credential record");
    return {
      keyId: row.keyId,
      clientId: row.clientId as string,
      owner: row.owner as string,
      digest: row.digest,
      projects,
      capabilities,
      createdAt: row.createdAt as number,
      expiresAt: row.expiresAt as number,
      revokedAt: row.revokedAt as number | null,
      lastUsedAt: row.lastUsedAt as number | null,
    };
  } catch {
    throw new CliError("unavailable", 503);
  }
}
