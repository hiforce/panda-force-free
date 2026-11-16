import { createHash } from "node:crypto";

export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
