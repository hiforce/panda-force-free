import type { SocialTarget } from "../../../shared/delivery/social.js";
import type { SocialAccounts } from "./ports.js";
import { DeliveryError } from "../errors.js";

/** A renewed grant can change its version, never the account or project receiving the content. */
export function currentBoundTarget(accounts: SocialAccounts, owner: string, original: SocialTarget): SocialTarget {
  const current = accounts.target(owner, original.id);
  if (
    current.id !== original.id ||
    current.projectId !== original.projectId ||
    current.accountId !== original.accountId
  )
    throw new DeliveryError("accountBindingChanged", 409);
  return current;
}
