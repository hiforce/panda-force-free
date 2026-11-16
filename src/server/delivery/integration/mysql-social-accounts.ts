import type { AsyncStore } from "../../../shared/async-store.js";
import type { MySQLSocialAccountService } from "../../connections/accounts/mysql-service.js";
import type { MySQLAccountTokens } from "../../connections/accounts/mysql-tokens.js";
import { DeliveryError } from "../errors.js";
import type { SocialAccounts } from "../social/ports.js";
export function mysqlSocialAccounts(
  accounts: MySQLSocialAccountService,
  tokens: MySQLAccountTokens,
): AsyncStore<SocialAccounts> {
  const scopes = ["tweet.read", "tweet.write", "users.read"];
  const target: AsyncStore<SocialAccounts>["target"] = async (owner, id) => {
    const account = await accounts.detail(owner, id);
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
  const assert: AsyncStore<SocialAccounts>["assert"] = async (owner, expected, purpose) => {
    const current = await target(owner, expected.id);
    if (
      current.projectId !== expected.projectId ||
      current.version !== expected.version ||
      current.accountId !== expected.accountId
    )
      throw new DeliveryError("authorizationChanged", 409);
    if (purpose === "media" && !(await accounts.detail(owner, expected.id)).grant?.scopes.includes("media.write"))
      throw new DeliveryError("authorizationRequired", 409);
  };
  return {
    target,
    assert,
    async access(owner, expected, purpose) {
      await assert(owner, expected, purpose);
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
