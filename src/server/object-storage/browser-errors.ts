export class StorageBrowseError extends Error {
  constructor(
    readonly label: "missing" | "denied" | "invalidPath" | "unavailable" | "driveAuthorization",
    readonly status: number,
  ) {
    super(label);
  }
}
