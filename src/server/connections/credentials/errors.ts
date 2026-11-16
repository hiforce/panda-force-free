export class CredentialError extends Error {
  constructor(
    readonly code:
      | "keyUnavailable"
      | "invalidCredential"
      | "unreadableCredential"
      | "credentialMissing"
      | "credentialConflict"
      | "refreshBusy"
      | "refreshFailed"
      | "credentialStoreUnavailable",
  ) {
    super(code);
  }
}
