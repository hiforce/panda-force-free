import { SearchError } from "../../shared/search/contracts.js";

/** A proven physical failure may rebuild derived data; provider outages must never trigger that repair. */
export class IndexIntegrityError extends SearchError {
  constructor(readonly reason: "missing" | "corrupt" | "unverified") {
    super("notReady", 409);
  }
}
