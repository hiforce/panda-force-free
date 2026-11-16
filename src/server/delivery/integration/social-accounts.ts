import type { SocialAccountService } from "../../connections/accounts/service.js";
import type { AccountTokens } from "../../connections/accounts/tokens.js";
import type { SocialAccounts } from "../social/ports.js";
import { DeliveryError } from "../errors.js";

export function socialAccounts(accounts: SocialAccountService, tokens: AccountTokens): SocialAccounts {
  const scopes = ["tweet.read", "tweet.write", "users.read"];
  const target: SocialAccounts["target"] = (owner, id) => {
    const account = accounts.detail(owner, id);
    if (
      !account.enabled ||
      !account.account ||
      !account.grant ||
      account.authorizationState === "reauthorizationRequired" ||
      account.authorizationState === "refreshing" ||
      scopes.some((scope) => !account.grant!.scopes.includes(scope))
    )
      throw new DeliveryError("authorizationRequired", 409);
    return {
      id,
      projectId: account.projectId,
      version: account.version,
      accountId: account.account.id,
      username: account.account.username,
    };
  };
  const assert: SocialAccounts["assert"] = (owner, expected, purpose) => {
    const current = target(owner, expected.id);
    if (
      current.projectId !== expected.projectId ||
      current.version !== expected.version ||
      current.accountId !== expected.accountId
    )
      throw new DeliveryError("authorizationChanged", 409);
    if (purpose === "media" && !accounts.detail(owner, expected.id).grant?.scopes.includes("media.write"))
      throw new DeliveryError("authorizationRequired", 409);
  };
  return {
    target,
    assert,
    async access(owner, expected, purpose) {
      assert(owner, expected, purpose);
      try {
        return await tokens.access(
          owner,
          expected.id,
          expected.version,
          purpose === "media" ? [...scopes, "media.write"] : scopes,
        );
      } catch {
        throw new DeliveryError("authorizationRequired", 409);
      }
    },
  };
}
