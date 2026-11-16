import { createHash, randomBytes } from "node:crypto";

export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** State and verifier are independent secrets; only the challenge is sent during consent. */
export function createPkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { state: randomBytes(32).toString("base64url"), verifier, challenge: pkceChallenge(verifier) };
}
