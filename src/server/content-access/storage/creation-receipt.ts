import { createHash } from "node:crypto";

type ProjectFields = { name: string; code: string; description: string };

export function projectCreationHash(fields: ProjectFields, creator?: string, members: readonly string[] = []) {
  return createHash("sha256")
    .update(JSON.stringify(creator ? [fields, creator, ...(members.length ? [[...members].sort()] : [])] : fields))
    .digest("hex");
}

/** An old self-grant only identifies the creator when it matches the original workspace receipt. */
export function creatorFromProjectReceipt(
  fields: ProjectFields,
  receipts: readonly string[],
  candidates: readonly string[],
) {
  const digests = new Set(receipts);
  const matched = candidates.filter(
    (candidate) => /^[a-f0-9]{64}$/.test(candidate) && digests.has(projectCreationHash(fields, candidate)),
  );
  return matched.length === 1 ? matched[0]! : null;
}
