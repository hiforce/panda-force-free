import { randomUUID } from "node:crypto";
import { isRecord } from "../../../shared/records.js";
import { BotError } from "../../../shared/bots/contracts.js";
import type { BotWorkspaceRecord } from "../workspace/storage.js";
import { botRequest } from "../network.js";
import { BotConnections, botConnectionView, type BotConnectionRecord } from "./connections.js";

export class BotProviderError extends Error {
  constructor(
    readonly code: "authentication" | "rateLimited" | "unavailable" | "rejected" | "unknown" | "invalidResponse",
    readonly outcome: "rejected" | "unknown" = "rejected",
    readonly retryAfter = 60,
  ) {
    super(code);
  }
}
const id = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value) ? value : "");
export function botMailAddress(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
  )
    throw new BotError("invalidMailAddress");
  return value.toLowerCase();
}
function retryDelay(value?: string) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(86400, n)) : 60;
}

/** Only fixed provider origins receive credentials. No source content can choose a delivery endpoint. */
export class BotProviders {
  constructor(
    readonly connections: BotConnections,
    private send: typeof botRequest = botRequest,
  ) {}
  private async request(
    url: string,
    method: "GET" | "POST",
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal,
    mutation = false,
  ) {
    let response: Awaited<ReturnType<typeof botRequest>>;
    try {
      response = await this.send(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        maxBytes: 512000,
        signal,
      });
    } catch {
      throw new BotProviderError(mutation ? "unknown" : "unavailable", mutation ? "unknown" : "rejected");
    }
    if (response.status === 429)
      throw new BotProviderError("rateLimited", "rejected", retryDelay(response.headers?.["retry-after"]));
    if ([401, 403].includes(response.status)) throw new BotProviderError("authentication");
    if (mutation && [408, 409, 499].includes(response.status)) throw new BotProviderError("unknown", "unknown");
    if (response.status >= 500)
      throw new BotProviderError(mutation ? "unknown" : "unavailable", mutation ? "unknown" : "rejected");
    if (response.status < 200 || response.status >= 300) throw new BotProviderError("rejected");
    let value: unknown;
    try {
      value = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new BotProviderError("invalidResponse", mutation ? "unknown" : "rejected");
    }
    if (!isRecord(value)) throw new BotProviderError("invalidResponse", mutation ? "unknown" : "rejected");
    return value;
  }
  async access(owner: string, row: BotWorkspaceRecord<BotConnectionRecord>, signal: AbortSignal) {
    if (row.data.state === "disabled" || row.data.failure === "tokenRefreshUnknown")
      throw new BotError("connectionUnavailable", 409);
    const secret = await this.connections.open(owner, row);
    if (row.data.kind === "slack") {
      if (typeof secret.token !== "string") throw new BotError("connectionUnavailable", 409);
      return secret.token;
    }
    if (
      typeof secret.accessToken === "string" &&
      typeof secret.expiresAt === "number" &&
      secret.expiresAt > Date.now() + 60000
    )
      return secret.accessToken;
    if (row.data.refresh) {
      if (row.data.refresh.expiresAt <= Date.now()) {
        await this.connections.update(owner, row, {
          ...row.data,
          state: "error",
          refresh: undefined,
          failure: "tokenRefreshUnknown",
        });
        throw new BotError("connectionUnavailable", 409);
      }
      throw new BotError("connectionRefreshPending", 409);
    }
    if (![secret.clientId, secret.clientSecret, secret.refreshToken].every((v) => typeof v === "string" && v))
      throw new BotError("connectionUnavailable", 409);
    const refresh = { id: randomUUID(), expiresAt: Date.now() + 30000 },
      data = { ...row.data, refresh };
    if (!(await this.connections.update(owner, row, data))) throw new BotError("staleConnection", 409);
    const claimed = { ...row, version: row.version + 1, data };
    try {
      const token = await this.request(
        "https://oauth2.googleapis.com/token",
        "POST",
        { "content-type": "application/x-www-form-urlencoded" },
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: String(secret.clientId),
          client_secret: String(secret.clientSecret),
          refresh_token: String(secret.refreshToken),
        }).toString(),
        signal,
        true,
      );
      if (
        typeof token.access_token !== "string" ||
        !token.access_token ||
        token.access_token.length > 16384 ||
        typeof token.expires_in !== "number" ||
        token.expires_in < 60 ||
        token.expires_in > 86400
      )
        throw new BotProviderError("invalidResponse", "unknown");
      const envelope = await this.connections.cipher.seal(this.connections.binding(owner, row), {
        ...secret,
        accessToken: token.access_token,
        expiresAt: Date.now() + token.expires_in * 1000,
        ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {}),
      });
      if (
        !(await this.connections.update(owner, claimed, {
          ...row.data,
          envelope,
          refresh: undefined,
          failure: undefined,
        }))
      )
        throw new BotError("staleConnection", 409);
      return token.access_token;
    } catch (error) {
      await this.connections.update(owner, claimed, {
        ...row.data,
        state: "error",
        refresh: undefined,
        failure:
          error instanceof BotProviderError && error.outcome === "rejected"
            ? "tokenRefreshRejected"
            : "tokenRefreshUnknown",
      });
      throw error;
    }
  }
  async verify(owner: string, connectionId: string, signal: AbortSignal) {
    let row = await this.connections.row(owner, connectionId);
    const token = await this.access(owner, row, signal);
    row = await this.connections.row(owner, connectionId);
    const value =
      row.data.kind === "slack"
        ? await this.request(
            "https://slack.com/api/auth.test",
            "POST",
            { authorization: "Bearer " + token, "content-type": "application/json" },
            "{}",
            signal,
          )
        : await this.request(
            "https://gmail.googleapis.com/gmail/v1/users/me/profile",
            "GET",
            { authorization: "Bearer " + token },
            undefined,
            signal,
          );
    if (row.data.kind === "slack" && value.ok !== true) throw new BotProviderError("authentication");
    const account =
      row.data.kind === "gmail"
        ? botMailAddress(value.emailAddress)
        : [id(value.team_id), id(value.user_id)].filter(Boolean).join("/");
    if (!account) throw new BotProviderError("invalidResponse");
    if (
      !(await this.connections.update(owner, row, {
        ...row.data,
        state: "ready",
        checkedAt: Date.now(),
        account,
        failure: undefined,
      }))
    )
      throw new BotError("staleConnection", 409);
    return botConnectionView(await this.connections.row(owner, connectionId));
  }
  async slack(
    owner: string,
    connectionId: string,
    channel: string,
    text: string,
    deliveryId: string,
    signal: AbortSignal,
  ) {
    const row = await this.connections.row(owner, connectionId, "slack");
    if (row.data.state !== "ready") throw new BotError("connectionUnavailable", 409);
    if (
      !/^[CGD][A-Z0-9]{6,32}$/.test(channel) ||
      !text.trim() ||
      text.length > 39000 ||
      !/^[a-f0-9-]{36}$/.test(deliveryId)
    )
      throw new BotError("invalidDelivery");
    const token = await this.access(owner, row, signal),
      value = await this.request(
        "https://slack.com/api/chat.postMessage",
        "POST",
        { authorization: "Bearer " + token, "content-type": "application/json; charset=utf-8" },
        JSON.stringify({
          channel,
          text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
          mrkdwn: false,
          parse: "none",
          link_names: false,
          client_msg_id: deliveryId,
          unfurl_links: false,
          unfurl_media: false,
        }),
        signal,
        true,
      );
    if (value.ok === false) {
      if (value.error === "ratelimited") throw new BotProviderError("rateLimited");
      const rejected = [
        "channel_not_found",
        "not_in_channel",
        "is_archived",
        "no_text",
        "msg_too_long",
        "invalid_auth",
        "token_revoked",
        "account_inactive",
        "missing_scope",
        "no_permission",
        "restricted_action",
        "not_allowed_token_type",
        "invalid_arguments",
        "invalid_arg_name",
        "invalid_array_arg",
        "invalid_charset",
        "invalid_form_data",
        "invalid_post_type",
        "invalid_blocks",
        "invalid_metadata",
        "invalid_attachments",
        "invalid_thread_ts",
        "thread_not_found",
        "reply_broadcast_not_allowed",
        "ekm_access_denied",
        "org_login_required",
        "team_access_not_granted",
      ].includes(String(value.error));
      throw new BotProviderError(rejected ? "rejected" : "unknown", rejected ? "rejected" : "unknown");
    }
    if (value.ok !== true || !id(value.ts) || value.channel !== channel)
      throw new BotProviderError("invalidResponse", "unknown");
    return { id: String(value.ts), channel };
  }
  async gmail(
    owner: string,
    connectionId: string,
    path: string,
    signal: AbortSignal,
    body?: Record<string, unknown>,
    mutation = false,
  ) {
    const row = await this.connections.row(owner, connectionId, "gmail");
    if (row.data.state !== "ready") throw new BotError("connectionUnavailable", 409);
    // This path is assembled by adapter code, never supplied by a browser or source item.
    if (!/^(?:messages|profile)(?:[/?]|$)/.test(path) || /[\r\n#]/.test(path)) throw new BotError("invalidDelivery");
    const token = await this.access(owner, row, signal);
    return this.request(
      "https://gmail.googleapis.com/gmail/v1/users/me/" + path,
      body ? "POST" : "GET",
      { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) },
      body ? JSON.stringify(body) : undefined,
      signal,
      mutation,
    );
  }
}
