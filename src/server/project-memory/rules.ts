import { visibleHarnessText } from "../../shared/harness/text.js";

import type { OrganizedMemoryRelationKind } from "../../shared/project-memory/contracts.js";

export interface MemoryClaimRelation {
  target: string;
  targetVersion: string;
  kind: OrganizedMemoryRelationKind | "unlink";
}

export interface MemoryClaim {
  key: string;
  title?: string;
  scope: string;
  value: string;
  replaces: boolean;
  relations?: MemoryClaimRelation[];
}

export function memoryKey(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[\s_.-]+/gu, "-");
}

// Explicit conventions are accepted only from a standalone authored line.
const convention =
  /^(Project convention|Replace project convention|项目约定|更新项目约定|項目約定|更新項目約定|專案約定|更新專案約定)(?:\s*\[([\p{L}\p{N}_. -]{1,48})\])?\s*[:：]\s*([\p{L}\p{N}_. -]{1,80})\s*[=＝]\s*(.{1,240})$/imu;
export const memoryCredentialPattern =
  /\b(?:password|secret|credential|api.?key|access.?token|private.?key)\b|密码|密碼|凭据|憑證|密钥|金鑰|令牌|-----BEGIN|\bBearer\s|https?:\/\/[^\s/]+:[^\s/]+@/iu;
export const memoryControlPattern = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export function verifiedMemoryTitle(value: unknown) {
  return typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 64 &&
    !memoryControlPattern.test(value) &&
    !memoryCredentialPattern.test(value)
    ? value
    : undefined;
}

export function extractMemoryClaims(text: string): MemoryClaim[] {
  if (Buffer.byteLength(text) > 16_384) return [];
  const claims = new Map<string, MemoryClaim>();
  // Fenced code and Markdown quotations can describe conventions without asserting them.
  let fence: string | undefined;
  for (const line of visibleHarnessText(text).split(/\r?\n/u)) {
    const delimiter = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence || memoryCredentialPattern.test(line) || memoryControlPattern.test(line)) continue;
    const match = convention.exec(line);
    if (!match) continue;
    const [, prefix, scope, name, textValue] = match;
    const claim = {
      key: memoryKey(name!),
      scope: memoryKey(scope ?? "project"),
      value: textValue!.trim(),
      replaces: /^(Replace|更新)/iu.test(prefix!),
    };
    const id = JSON.stringify([claim.scope, claim.key, claim.value]);
    if (claim.value && !claims.has(id)) claims.set(id, claim);
    if (claims.size >= 8) break;
  }
  return [...claims.values()];
}

// Native transports may join authored text and application instructions without separators.
export function visibleNativeMemoryText(text: string) {
  return visibleHarnessText(
    text
      .replace(
        /<panda_attachment_workspace>\r?\n(?:PandaForce application context:|PandaForce could not prepare)[\s\S]*?(?:<\/panda_attachment_workspace>|$)/gu,
        "",
      )
      .replace(/<panda_session_skills>\r?\n[\s\S]*?(?:<\/panda_session_skills>|$)/gu, ""),
  );
}
