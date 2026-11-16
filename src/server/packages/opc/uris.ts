import { OpcError, opcAssert } from "./errors.js";

/** OPC part equivalence folds ASCII case; physical ZIP spellings remain unchanged. */
export const opcPartKey = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

function segment(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new OpcError("invalidPartName");
  }
  opcAssert(
    decoded && !decoded.includes("/") && !decoded.includes("\\") && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(decoded),
    "invalidPartName",
  );
  return decoded;
}

export function physicalPartName(path: string): string {
  const parts = path.split("/").map(segment);
  opcAssert(
    parts.every((part) => part !== "." && part !== ".."),
    "invalidPartName",
  );
  return parts.join("/");
}

export interface OpcTarget {
  readonly name: string;
  readonly fragment: string | null;
}
/** URI references are resolved in memory; neither external links nor package paths become host paths. */
export function resolveOpcTarget(source: string | null, target: string): OpcTarget {
  opcAssert(
    target.length > 0 &&
      target.length <= 8192 &&
      !/[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(target) &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:|^\/\//.test(target),
    "invalidPartName",
  );
  const hash = target.indexOf("#"),
    path = hash < 0 ? target : target.slice(0, hash),
    rawFragment = hash < 0 ? null : target.slice(hash + 1);
  opcAssert(!path.includes("?"), "invalidPartName");
  let fragment: string | null = null;
  if (rawFragment !== null) {
    try {
      fragment = decodeURIComponent(rawFragment);
    } catch {
      throw new OpcError("invalidPartName");
    }
    opcAssert(!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(fragment), "invalidPartName");
  }
  if (!path) {
    opcAssert(source, "invalidPartName");
    return { name: source, fragment };
  }
  const stack = path.startsWith("/") ? [] : (source?.split("/").slice(0, -1) ?? []),
    segments = (path.startsWith("/") ? path.slice(1) : path).split("/");
  for (const raw of segments) {
    const value = segment(raw);
    if (value === ".") continue;
    if (value === "..") {
      opcAssert(stack.length, "invalidPartName");
      stack.pop();
    } else stack.push(value);
  }
  opcAssert(stack.length && !path.endsWith("/"), "invalidPartName");
  return { name: stack.join("/"), fragment };
}

export function relationshipPartName(part: string | null): string {
  if (part === null) return "_rels/.rels";
  const pieces = part.split("/"),
    file = pieces.pop()!;
  return [...pieces, "_rels", file + ".rels"].join("/");
}
