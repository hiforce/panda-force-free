import { isRecord } from "../../../shared/records.js";
import { isStoredPassword } from "../security.js";
import { AccountError, type LocalRole, type LocalUserRecord } from "./contracts.js";

export function memberEmail(value: unknown) {
  if (typeof value !== "string") throw new AccountError("invalidEmail");
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email) ||
    email.includes("..")
  )
    throw new AccountError("invalidEmail");
  return email;
}
export function memberRole(value: unknown): LocalRole {
  if (value !== "admin" && value !== "member") throw new AccountError("invalidInput");
  return value;
}
export function memberFields(value: unknown, keys: readonly string[]) {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new AccountError("invalidInput");
  return value;
}
export function memberId(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    throw new AccountError("notFound", 404);
  return value;
}
/** Secret material and delivery leases never enter administration responses. */
export function memberView(user: LocalUserRecord) {
  return {
    id: user.id,
    email: user.username,
    role: user.role,
    enabled: user.enabled,
    revision: user.revision,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    activated: Boolean(user.password),
    ...(user.invitation
      ? { invitation: { expiresAt: user.invitation.expiresAt, state: user.invitation.delivery.state } }
      : {}),
  };
}
export function decodeMember(raw: string): LocalUserRecord {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      memberId(value.id) !== value.id ||
      memberEmail(value.username) !== value.username ||
      memberRole(value.role) !== value.role ||
      typeof value.enabled !== "boolean" ||
      (!isStoredPassword(value.password) && value.password !== null)
    )
      throw Error();
    for (const field of ["revision", "createdAt", "updatedAt"])
      if (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]) || Number(value[field]) < 1)
        throw Error();
    if (value.ownerId !== undefined && (typeof value.ownerId !== "string" || !/^[a-f0-9]{64}$/.test(value.ownerId)))
      throw Error();
    if (
      value.credentialRevision !== undefined &&
      (!Number.isSafeInteger(value.credentialRevision) || Number(value.credentialRevision) < 1)
    )
      throw Error();
    if (value.password === null && !isRecord(value.invitation)) throw Error();
    if (
      value.recoveryRequest !== undefined &&
      (!isRecord(value.recoveryRequest) ||
        !Number.isSafeInteger(value.recoveryRequest.at) ||
        memberId(value.recoveryRequest.id) !== value.recoveryRequest.id)
    )
      throw Error();
    if (value.invitation !== undefined) {
      const invite = value.invitation;
      if (
        !isRecord(invite) ||
        typeof invite.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(invite.digest) ||
        typeof invite.expiresAt !== "number" ||
        !Number.isSafeInteger(invite.expiresAt) ||
        typeof invite.operationId !== "string" ||
        !isRecord(invite.delivery) ||
        !["pending", "sending", "sent", "failed"].includes(String(invite.delivery.state))
      )
        throw Error();
      if (invite.code !== undefined) {
        if (
          !isRecord(invite.code) ||
          !isRecord(invite.code.envelope) ||
          !Number.isSafeInteger(invite.requestedAt) ||
          Number(invite.requestedAt) < 1 ||
          !Number.isSafeInteger(invite.code.attempts) ||
          Number(invite.code.attempts) < 0 ||
          Number(invite.code.attempts) > 5 ||
          (invite.code.verifiedAt !== undefined &&
            (!Number.isSafeInteger(invite.code.verifiedAt) || typeof invite.code.verificationId !== "string"))
        )
          throw Error();
      }
    }
    return value as unknown as LocalUserRecord;
  } catch {
    throw new AccountError("unavailable", 503);
  }
}
