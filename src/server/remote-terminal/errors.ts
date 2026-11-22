import type { RemoteErrorCode } from "../../shared/workspace-tools/remote.js";

export class RemoteError extends Error {
  constructor(readonly code: RemoteErrorCode) {
    super(code);
  }
}
