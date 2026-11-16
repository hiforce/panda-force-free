import { stableJson } from "../../../shared/stable-json.js";
import { isRecord } from "../../../shared/records.js";
import { documentRecoveryStorage, STORAGE_KEYS } from "../../storage.js";
import { DocumentApiError } from "../api.js";

export interface PublicationCommand {
  kind: "space-create" | "space-configure" | "link-create" | "link-update" | "link-remove";
  resource?: string;
  input: Record<string, unknown>;
}
export interface PendingPublicationCommand {
  projectId: string;
  operationId: string;
  command: PublicationCommand;
}
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const unavailable = () => new DocumentApiError(503, { messageId: "documents.publicationRecoveryUnavailable" });
const rejected = new Set(
  [
    "invalidInput",
    "invalidPlacementMetadata",
    "invalidPlacementTarget",
    "placementPathConflict",
    "placementAlreadyLinked",
    "placementLocaleMismatch",
    "sourceEditionMissing",
    "tooManyPlacements",
    "invalidSourceConfiguration",
    "unknownTheme",
    "incompatibleTheme",
    "spaceConflict",
    "conflict",
    "duplicate",
    "tooLarge",
  ].map((code) => "documents." + code),
);

function definitive(error: unknown) {
  if (!(error instanceof DocumentApiError) || !isRecord(error.payload)) return false;
  const id = error.payload.messageId;
  return (
    typeof id === "string" &&
    (([400, 409, 413, 422].includes(error.status) && rejected.has(id)) ||
      (error.status === 403 && id === "documents.outsideRoots") ||
      (error.status === 404 && id === "documents.sourceUnavailable"))
  );
}

/** One frozen metadata mutation per account/project/tab survives a lost response and navigation. */
export class PublicationCommands {
  private readonly key: string;
  private saved: PendingPublicationCommand | null;
  private active: Promise<unknown> | null = null;
  constructor(
    identity: string,
    private projectId: string,
    private request: (value: PendingPublicationCommand) => Promise<unknown>,
    private storage: RecoveryStorage = documentRecoveryStorage,
  ) {
    if (!identity || !uuid(projectId)) throw unavailable();
    this.key = STORAGE_KEYS.documentPublicationCommandFor(identity, projectId);
    this.saved = this.read();
  }
  private read(): PendingPublicationCommand | null {
    try {
      const bytes = this.storage.getItem(this.key);
      if (!bytes) return null;
      if (bytes.length > 150000) throw unavailable();
      const value: unknown = JSON.parse(bytes);
      if (
        !isRecord(value) ||
        value.schema !== 1 ||
        value.projectId !== this.projectId ||
        !uuid(value.operationId) ||
        !isRecord(value.command) ||
        !isRecord(value.command.input) ||
        !["space-create", "space-configure", "link-create", "link-update", "link-remove"].includes(
          String(value.command.kind),
        ) ||
        (value.command.resource !== undefined && !uuid(value.command.resource)) ||
        (["space-configure", "link-update", "link-remove"].includes(String(value.command.kind)) &&
          !uuid(value.command.resource))
      )
        throw unavailable();
      return {
        projectId: this.projectId,
        operationId: value.operationId,
        command: {
          kind: value.command.kind as PublicationCommand["kind"],
          ...(typeof value.command.resource === "string" ? { resource: value.command.resource } : {}),
          input: value.command.input,
        },
      };
    } catch {
      throw unavailable();
    }
  }
  private write(value: PendingPublicationCommand | null) {
    try {
      if (value) {
        const bytes = stableJson({ schema: 1, ...value });
        if (bytes.length > 150000) throw unavailable();
        this.storage.setItem(this.key, bytes);
      } else this.storage.removeItem(this.key);
      this.saved = value;
    } catch {
      throw unavailable();
    }
  }
  get pending() {
    return this.saved !== null;
  }
  execute<T>(command: PublicationCommand): Promise<T> {
    const previous = this.read();
    this.saved = previous;
    if (previous && stableJson(previous.command) !== stableJson(command))
      return Promise.reject(new DocumentApiError(409, { messageId: "documents.pendingPublicationChange" }));
    if (this.active) return this.active as Promise<T>;
    const pending = previous ?? {
      projectId: this.projectId,
      operationId: crypto.randomUUID(),
      command: structuredClone(command),
    };
    this.write(pending);
    return this.perform(pending) as Promise<T>;
  }
  retry() {
    const pending = this.read();
    this.saved = pending;
    if (this.active) return this.active;
    if (!pending) return Promise.resolve(null);
    return this.perform(pending);
  }
  private perform(value: PendingPublicationCommand) {
    const operation = Promise.resolve().then(async () => {
      try {
        const result = await this.request(structuredClone(value));
        if (this.read()?.operationId === value.operationId) this.write(null);
        return result;
      } catch (error) {
        if (definitive(error)) if (this.read()?.operationId === value.operationId) this.write(null);
        throw error;
      } finally {
        this.active = null;
      }
    });
    this.active = operation;
    return operation;
  }
}
