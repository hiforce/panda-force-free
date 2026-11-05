import type { IncomingMessage, ServerResponse } from "node:http";
import { reportDiagnostic } from "../../shared/diagnostics.js";
import { errorPayload } from "../i18n/error-payload.js";
import { respondJson } from "./respond.js";

/** Keep an unexpected asynchronous route failure from hanging its HTTP request. */
export function withRequestErrors(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    void Promise.resolve()
      .then(() => handler(request, response))
      .catch((error: unknown) => {
        reportDiagnostic("http-request", error, { level: "error" });
        if (response.writableEnded || response.destroyed) return;
        if (response.headersSent) {
          response.destroy();
          return;
        }
        respondJson(response, 500, errorPayload("errors.unexpectedError"));
      });
  };
}
