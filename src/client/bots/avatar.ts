import { DEFAULT_BOT_AVATAR, type BotConfig } from "../../shared/bots/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { PANDA_SHAPES } from "../../shared/brand.js";
import { codexIcon } from "../codex-icons.js";

const pandaAvatar = `<span class="icon-slot"><svg viewBox="0 0 100 100" class="bot-panda-symbol" aria-hidden="true">${PANDA_SHAPES.replaceAll("#17191f", "var(--bot-panda-ink)").replaceAll("var(--panda-face,#fff)", "var(--bot-panda-face)").replaceAll("var(--panda-flame,#ef233c)", "var(--bot-panda-flame)")}</svg></span>`;

export function botAvatarHtml(bot?: Pick<BotConfig, "avatar" | "name">, preview?: string): string {
  const avatar = bot?.avatar ?? DEFAULT_BOT_AVATAR,
    image = preview ?? (avatar?.type === "image" ? "/api/bots/avatars/" + encodeURIComponent(avatar.id) : ""),
    icon = avatar?.type === "icon" ? avatar.icon : "panda",
    tone = avatar?.type === "icon" ? avatar.tone : "accent";
  return `<span class="bot-avatar" data-avatar-tone="${e(tone)}" aria-hidden="true">${image ? `<img src="${e(image)}" alt="" width="64" height="64" decoding="async">` : icon === "panda" ? pandaAvatar : codexIcon(icon)}</span>`;
}
