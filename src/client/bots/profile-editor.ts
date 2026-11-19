import {
  BOT_AVATAR_ICONS,
  BOT_AVATAR_CHOICES,
  BOT_AVATAR_TONES,
  DEFAULT_BOT_AVATAR,
  type BotAvatar,
  type BotConfig,
} from "../../shared/bots/contracts.js";
import { setMessageHtml } from "../i18n.js";
import { botAvatarHtml } from "./avatar.js";
import { botUi, type BotContext } from "./ui.js";

const iconNames = [
  "cli.botAvatarPanda",
  "cli.botAvatarCat",
  "cli.botAvatarDog",
  "cli.botAvatarFox",
  "cli.botAvatarOwl",
  "cli.botAvatarRabbit",
  "cli.botAvatarBear",
  "cli.botAvatarTiger",
  "cli.botAvatarPenguin",
] as const;
const presets = [
  { name: "cli.botGentle", traits: "cli.botGentleTraits", voice: "cli.botGentleVoice" },
  { name: "cli.botPrecise", traits: "cli.botPreciseTraits", voice: "cli.botPreciseVoice" },
  { name: "cli.botCurious", traits: "cli.botCuriousTraits", voice: "cli.botCuriousVoice" },
  { name: "cli.botDirect", traits: "cli.botDirectTraits", voice: "cli.botDirectVoice" },
] as const;
export function createBotProfileEditor(context: BotContext, bot?: BotConfig) {
  const { h, attributes, optional, button, field } = botUi(context.t);
  let avatar: BotAvatar = bot?.avatar ?? { ...DEFAULT_BOT_AVATAR },
    upload = "",
    epoch = 0,
    preparing = false;
  const urls = new Set<string>();
  const html = () =>
    `<section class="bot-profile-editor"><div class="bot-profile-preview" data-profile-preview></div><div class="bot-avatar-tools"><div class="bot-record-actions">${button("cli.botUploadAvatar", "data-avatar-upload")}${button("cli.botUseIcon", "data-avatar-reset")}<input type="file" accept="image/png,image/jpeg,image/webp" data-avatar-file hidden></div><small>${h("cli.botAvatarHint")}</small><fieldset class="bot-avatar-picker"><legend>${h("cli.botAvatar")}</legend>${BOT_AVATAR_CHOICES.map((icon, i) => `<button type="button" data-avatar-icon="${icon}" ${attributes("aria-label", iconNames[i]!)} ${attributes("title", iconNames[i]!)}>${botAvatarHtml({ name: "", avatar: { type: "icon", icon, tone: "accent" } })}</button>`).join("")}</fieldset><fieldset class="bot-avatar-tones"><legend>${h("cli.botTone")}</legend>${BOT_AVATAR_TONES.map((tone, i) => `<button type="button" data-avatar-tone-choice="${tone}" class="bot-tone" data-avatar-tone="${tone}">${h((["cli.botToneAccent", "cli.botToneSuccess", "cli.botToneWarning"] as const)[i]!)}</button>`).join("")}</fieldset></div></section>`;
  const personality = () =>
    `<section class="bot-form-section">${field("cli.botRole", "role", 'maxlength="120"')}<details class="bot-personality" ${bot?.persona?.traits || bot?.persona?.voice ? "open" : ""}><summary>${h("cli.botProfileDetails")}</summary><p class="bot-hint">${h("cli.botPersonaHint")}</p><fieldset class="bot-persona-presets"><legend>${h("cli.botPreset")}</legend>${presets.map((preset, i) => button(preset.name, `data-persona-preset="${i}"`)).join("")}</fieldset><label class="wb-field"><span>${h("cli.botPersonality")}</span><textarea name="pf-bot-traits" rows="3" maxlength="2000"></textarea></label><label class="wb-field"><span>${h("cli.botVoice")}</span><textarea name="pf-bot-voice" rows="2" maxlength="1000"></textarea></label>${field("cli.botMotto", "motto", 'maxlength="160"')}</details></section>`;
  return {
    html,
    personality,
    mount(dialog: HTMLDialogElement) {
      const preview = dialog.querySelector<HTMLElement>("[data-profile-preview]")!;
      const input = (name: string) =>
        dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="pf-bot-${name}"]`)!;
      for (const name of ["role", "traits", "voice", "motto"] as const) input(name).value = bot?.persona?.[name] ?? "";
      function update() {
        setMessageHtml(
          preview,
          `${botAvatarHtml({ name: input("name").value, avatar }, upload || undefined)}<div><strong>${optional(input("name").value, "cli.botPreviewName")}</strong><span>${optional(input("role").value, "cli.botPreviewRole")}</span><p>${optional(input("motto").value, "cli.botPreviewMotto")}</p></div>`,
        );
        dialog
          .querySelectorAll<HTMLButtonElement>("[data-avatar-icon]")
          .forEach((b) =>
            b.setAttribute(
              "aria-pressed",
              String(!upload && avatar.type === "icon" && avatar.icon === b.dataset.avatarIcon),
            ),
          );
        dialog.querySelectorAll<HTMLButtonElement>("[data-avatar-tone-choice]").forEach((b) => {
          b.setAttribute("aria-pressed", String(avatar.type === "icon" && avatar.tone === b.dataset.avatarToneChoice));
          b.disabled = preparing || !!upload || avatar.type === "image";
        });
        dialog.querySelectorAll<HTMLButtonElement>("[data-persona-preset]").forEach((b) => {
          const preset = presets[Number(b.dataset.personaPreset)]!;
          b.setAttribute(
            "aria-pressed",
            String(
              input("traits").value === context.t(preset.traits) && input("voice").value === context.t(preset.voice),
            ),
          );
        });
        dialog.querySelector<HTMLButtonElement>("[data-avatar-reset]")!.hidden = !upload && avatar.type !== "image";
      }
      function cancelUpload() {
        epoch++;
        preparing = false;
        for (const url of urls) URL.revokeObjectURL(url);
        urls.clear();
      }
      dialog.addEventListener("input", update);
      dialog.addEventListener("close", () => {
        cancelUpload();
        upload = "";
      });
      dialog.querySelectorAll<HTMLButtonElement>("[data-avatar-icon]").forEach(
        (b) =>
          (b.onclick = () => {
            cancelUpload();
            upload = "";
            avatar = {
              type: "icon",
              icon: b.dataset.avatarIcon as (typeof BOT_AVATAR_ICONS)[number],
              tone: avatar.type === "icon" ? avatar.tone : "accent",
            };
            update();
          }),
      );
      dialog.querySelectorAll<HTMLButtonElement>("[data-avatar-tone-choice]").forEach(
        (b) =>
          (b.onclick = () => {
            cancelUpload();
            upload = "";
            avatar = {
              type: "icon",
              icon: avatar.type === "icon" ? avatar.icon : "bot",
              tone: b.dataset.avatarToneChoice as (typeof BOT_AVATAR_TONES)[number],
            };
            update();
          }),
      );
      dialog.querySelector<HTMLButtonElement>("[data-avatar-reset]")!.onclick = () => {
        cancelUpload();
        upload = "";
        avatar = { ...DEFAULT_BOT_AVATAR };
        update();
      };
      dialog.querySelectorAll<HTMLButtonElement>("[data-persona-preset]").forEach(
        (b) =>
          (b.onclick = () => {
            const preset = presets[Number(b.dataset.personaPreset)]!;
            input("traits").value = context.t(preset.traits);
            input("voice").value = context.t(preset.voice);
            update();
          }),
      );
      const fileInput = dialog.querySelector<HTMLInputElement>("[data-avatar-file]")!;
      dialog.querySelector<HTMLButtonElement>("[data-avatar-upload]")!.onclick = () => fileInput.click();
      fileInput.onchange = () => {
        cancelUpload();
        const file = fileInput.files?.[0],
          current = epoch;
        fileInput.value = "";
        update();
        if (!file) return;
        if (file.size > 2 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type))
          return context.notice(context.t("cli.botAvatarInvalid"));
        preparing = true;
        update();
        context.notice(context.t("cli.botAvatarPreparing"));
        const url = URL.createObjectURL(file),
          image = new Image();
        urls.add(url);
        image.onload = () => {
          try {
            if (current !== epoch || !dialog.open) return;
            if (image.naturalWidth * image.naturalHeight > 16000000) throw new Error("image too large");
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 256;
            const scale = Math.max(256 / image.naturalWidth, 256 / image.naturalHeight),
              w = image.naturalWidth * scale,
              h = image.naturalHeight * scale;
            canvas.getContext("2d")!.drawImage(image, (256 - w) / 2, (256 - h) / 2, w, h);
            const next = canvas.toDataURL("image/webp", 0.85);
            if (next.length > 400000) throw new Error("image too large");
            upload = next;
            update();
            context.notice("");
          } catch {
            if (current === epoch) context.notice(context.t("cli.botAvatarInvalid"));
          } finally {
            urls.delete(url);
            URL.revokeObjectURL(url);
            if (current === epoch) {
              preparing = false;
              update();
            }
          }
        };
        image.onerror = () => {
          urls.delete(url);
          URL.revokeObjectURL(url);
          if (current === epoch) {
            preparing = false;
            update();
            context.notice(context.t("cli.botAvatarInvalid"));
          }
        };
        image.src = url;
      };
      update();
    },
    value() {
      if (preparing) throw new Error("avatarBusy");
      return upload ? { type: "upload" as const, data: upload } : avatar;
    },
  };
}
