import { createHash } from "node:crypto";

/** Audit references identify an authenticated operator without persisting identity claims or credentials. */
export function auditPrincipal(identity: unknown): string {
  if (!identity || typeof identity !== "object") return "local-access";
  const record = identity as Record<string, unknown>;
  if (typeof record.uuid !== "string" || typeof record.tenantId !== "string") throw new Error("Invalid audit identity");
  return (
    "idaas:" +
    createHash("sha256")
      .update(JSON.stringify([record.tenantId, record.uuid]))
      .digest("hex")
  );
}
