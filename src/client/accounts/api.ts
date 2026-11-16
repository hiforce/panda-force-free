import { request } from "../http-client.js";
import type {
  AccountAuthorization,
  SocialAccount,
  SocialAccountInput,
  SocialAccountUpdate,
} from "../../shared/connections/accounts.js";

export class AccountApiError extends Error {
  constructor(readonly payload: unknown) {
    super("Account connection request failed");
  }
}
async function json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await request("/api/publication-accounts" + path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new AccountApiError(value);
  return value as T;
}
const query = (key: string, value: string) => "?" + new URLSearchParams({ [key]: value });
export const accountsApi = {
  list: (project: string) => json<{ accounts: SocialAccount[] }>(query("project", project)),
  detail: (id: string) => json<{ account: SocialAccount }>("/detail" + query("id", id)),
  create: (input: SocialAccountInput) => json<{ account: SocialAccount }>("", "POST", input),
  update: (id: string, input: SocialAccountUpdate) =>
    json<{ account: SocialAccount }>("/detail" + query("id", id), "PUT", input),
  authorize: (id: string, version: number) =>
    json<{ authorization: AccountAuthorization & { url: string } }>("/authorize", "POST", { id, version }),
  disconnect: (id: string, version: number) => json<{ account: SocialAccount }>("/disconnect", "POST", { id, version }),
};
