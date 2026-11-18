import type { MessageId } from "../i18n/messages.js";
import type { OriginalStorageErrorCode } from "./contracts.js";

export const originalStorageErrorMessages = {
  storageInvalidConfiguration: "storage.errorInvalidConfiguration",
  storageUnavailable: "storage.errorUnavailable",
  storageDenied: "storage.errorDenied",
  storageConflict: "storage.errorConflict",
  storageTooLarge: "storage.errorTooLarge",
  storageIntegrity: "storage.errorIntegrity",
  storageAdministratorRequired: "storage.errorAdministrator",
  storageAuthenticationRequired: "storage.errorAuthentication",
} as const satisfies Record<OriginalStorageErrorCode, MessageId>;
