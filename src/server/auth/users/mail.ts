import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { CredentialCipher } from "../../connections/credentials/cipher.js";
import { FileCredentialKey, initializeCredentialKey } from "../../connections/credentials/file-key.js";
import { serverTranslator } from "../../i18n/messages.js";
import { escapeHtml } from "../../../shared/html.js";
import { AccountError, type LocalUserRepository } from "./contracts.js";
import { memberEmail, memberFields } from "./records.js";
import type { InvitationMail } from "./invitations.js";
import { smtpSession, type SmtpConnection } from "./smtp.js";

const smtpBinding = {
  connectionId: "bcd0eb15-66ae-4c1a-a19f-451509805b38",
  connectorId: "panda-smtp",
  ownerId: "installation",
};
function text(value: unknown, maximum: number) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new AccountError("invalidInput");
  return value.trim();
}
function publicUrl(value: unknown) {
  try {
    const url = new URL(text(value, 2048));
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw Error();
    return url.origin;
  } catch {
    throw new AccountError("invalidInput");
  }
}

/** SMTP configuration belongs to the application store; its encryption key remains in a private mounted file. */
export class LocalAccountMail implements InvitationMail {
  readonly cipher: CredentialCipher;
  constructor(
    private readonly repository: LocalUserRepository,
    private readonly keyPath: string,
    private readonly transport = smtpSession,
  ) {
    this.cipher = new CredentialCipher(new FileCredentialKey(keyPath));
  }
  async initialize() {
    if (existsSync(this.keyPath)) return;
    const settings = await this.repository.settings();
    if (
      settings.smtp?.password ||
      settings.binding?.invitation?.delivery.envelope ||
      settings.administratorReset?.invitation?.delivery.envelope ||
      (await this.repository.list()).some((user) => user.invitation?.delivery.envelope)
    )
      throw new AccountError("unavailable", 503);
    await initializeCredentialKey(this.keyPath);
  }
  async overview() {
    const settings = await this.repository.settings(),
      smtp = settings.smtp;
    return {
      revision: settings.revision,
      configured: Boolean(smtp),
      ...(smtp
        ? {
            host: smtp.host,
            port: smtp.port,
            security: smtp.security,
            username: smtp.username,
            passwordSet: Boolean(smtp.password),
            from: smtp.from,
            publicUrl: smtp.publicUrl,
            ca: smtp.ca,
          }
        : {}),
    };
  }
  async require() {
    const smtp = (await this.repository.settings()).smtp;
    if (!smtp) throw new AccountError("smtpRequired", 409);
    return smtp;
  }
  private async connection(): Promise<SmtpConnection> {
    const smtp = await this.require();
    const secret = smtp.password ? await this.cipher.open(smtpBinding, smtp.password) : {};
    if (smtp.username && typeof secret.password !== "string") throw new AccountError("unavailable", 503);
    return { ...smtp, password: typeof secret.password === "string" ? secret.password : "" };
  }
  async save(input: unknown, signal: AbortSignal) {
    const fields = memberFields(input, [
      "revision",
      "host",
      "port",
      "security",
      "username",
      "password",
      "from",
      "publicUrl",
      "ca",
    ]);
    const previous = await this.repository.settings();
    if (fields.revision !== previous.revision) throw new AccountError("conflict", 409);
    const host = text(fields.host, 253),
      username = text(fields.username ?? "", 254),
      from = memberEmail(fields.from),
      url = publicUrl(fields.publicUrl);
    if (
      !host ||
      (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) ||
      !Number.isInteger(fields.port) ||
      Number(fields.port) < 1 ||
      Number(fields.port) > 65535 ||
      !["tls", "starttls"].includes(String(fields.security))
    )
      throw new AccountError("invalidInput");
    const supplied = typeof fields.password === "string" ? fields.password : "";
    if (supplied.length > 4096 || /[\r\n\0]/.test(supplied)) throw new AccountError("invalidInput");
    if (typeof fields.ca !== "string" && fields.ca !== undefined) throw new AccountError("invalidInput");
    const ca = String(fields.ca ?? "").trim();
    if (Buffer.byteLength(ca) > 16384 || (ca && !ca.startsWith("-----BEGIN CERTIFICATE-----")))
      throw new AccountError("invalidInput");
    await this.initialize();
    const old = previous.smtp,
      unchanged =
        old &&
        old.host === host &&
        old.port === fields.port &&
        old.security === fields.security &&
        old.username === username;
    let password = supplied;
    if (username && !password && unchanged && old.password) {
      const secret = await this.cipher.open(smtpBinding, old.password);
      password = typeof secret.password === "string" ? secret.password : "";
    }
    if (username && !password) throw new AccountError("smtpPasswordRequired");
    const configuration = {
      host,
      port: Number(fields.port),
      security: fields.security as "tls" | "starttls",
      username,
      from,
      publicUrl: url,
      ca,
    };
    await this.transport({ ...configuration, password }, signal);
    const sealed = username ? await this.cipher.seal(smtpBinding, { password }) : null;
    await this.repository.saveSettings(
      { ...previous, revision: previous.revision + 1, smtp: { ...configuration, password: sealed } },
      previous.revision,
    );
    return this.overview();
  }
  async send(message: Parameters<InvitationMail["send"]>[0], signal: AbortSignal) {
    const smtp = await this.require(),
      connection = await this.connection(),
      t = serverTranslator(message.locale ?? "en");
    const subject = message.code
      ? t("users.codeSubject")
      : t(
          message.purpose === "bind"
            ? "users.bindingSubject"
            : message.purpose === "reset"
              ? "users.resetSubject"
              : "users.invitationSubject",
        );
    const title = message.code
      ? t("users.codeMailTitle")
      : t(
          message.purpose === "bind"
            ? "users.bindingMail"
            : message.purpose === "reset"
              ? "users.resetMail"
              : "users.invitationMail",
        );
    const content = message.code
      ? `<p>${escapeHtml(t("users.codeMailHint"))}</p><p style="font:700 32px/1.6 monospace;letter-spacing:8px" data-verification-code>${escapeHtml(message.code)}</p><p>${escapeHtml(t("users.codeExpiry"))}</p>`
      : `<p>${escapeHtml(t("users.mailExpiry"))}</p><p><a href="${escapeHtml(message.link)}">${escapeHtml(t(message.purpose === "bind" ? "users.verifyEmail" : "users.setPassword"))}</a></p>`;
    const html = `<!doctype html><html><body><h1>${escapeHtml(title)}</h1>${content}<p>${escapeHtml(t("users.mailIgnore"))}</p></body></html>`;
    const encoded = Buffer.from(html)
      .toString("base64")
      .match(/.{1,76}/g)!
      .join("\r\n");
    const source = [
      `From: <${smtp.from}>`,
      `To: <${memberEmail(message.to)}>`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
      `Message-ID: <${message.id}@${smtp.from.split("@")[1]}>`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      encoded,
    ].join("\r\n");
    await this.transport(connection, signal, { from: smtp.from, to: message.to, source });
  }
}
