import { randomUUID } from "node:crypto";
import {
  BotError,
  DEFAULT_BOT_AVATAR,
  botText,
  botAvatar,
  botPersona,
  type BotConfig,
} from "../../shared/bots/contracts.js";

function hosts(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((host) => typeof host !== "string" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))
  )
    throw new BotError("invalidHosts");
  return [...new Set(value as string[])];
}
export function newBotRecord(owner: string, value: Record<string, unknown>): BotConfig {
  const code = botText(value.code, 64);
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(code)) throw new BotError("invalidCode");
  return {
    id: randomUUID(),
    owner,
    code,
    name: botText(value.name, 120),
    model: botText(value.model ?? "", 128, true),
    instructions: botText(value.instructions ?? "", 16000, true),
    active: true,
    callbackHosts: hosts(value.callbackHosts ?? []),
    sessionId: null,
    avatar: "avatar" in value ? botAvatar(value.avatar) : { ...DEFAULT_BOT_AVATAR },
    ...("persona" in value ? { persona: botPersona(value.persona) } : {}),
    createdAt: Date.now(),
  };
}
export function editedBotRecord(current: BotConfig, value: Record<string, unknown>): BotConfig {
  const fields = ["name", "model", "instructions", "callbackHosts", "active", "avatar", "persona"];
  if (!Object.keys(value).length || Object.keys(value).some((key) => !fields.includes(key)))
    throw new BotError("invalidInput");
  const next = { ...current };
  if ("name" in value) next.name = botText(value.name, 120);
  if ("model" in value) next.model = botText(value.model, 128, true);
  if ("instructions" in value) next.instructions = botText(value.instructions, 16000, true);
  if ("callbackHosts" in value) next.callbackHosts = hosts(value.callbackHosts);
  if ("avatar" in value) next.avatar = botAvatar(value.avatar);
  if ("persona" in value) next.persona = botPersona(value.persona);
  if ("active" in value) {
    if (typeof value.active !== "boolean") throw new BotError("invalidInput");
    next.active = value.active;
  }
  return next;
}
