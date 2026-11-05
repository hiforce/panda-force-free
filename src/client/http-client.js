import { reportDiagnostic } from "../shared/diagnostics.js";
/** Authentication observation is explicit; the browser's fetch function is never replaced. */
/** @param {{fetchImpl?: (input: RequestInfo | URL, options?: RequestInit) => Promise<Response>; origin?: () => string | undefined}} options */
export function createHttpClient({
  fetchImpl = /** @param {Parameters<typeof globalThis.fetch>} args */ (...args) => globalThis.fetch(...args),
  origin = () => globalThis.location?.origin,
} = {}) {
  /** @type {((options?: {force?: boolean}) => unknown) | null} */
  let authenticationHandler = null;
  return {
    /** @param {RequestInfo | URL} input @param {RequestInit} [options] */
    async request(input, options) {
      const response = await fetchImpl(input, options);
      if (response.status === 401 && authenticationHandler) {
        const base = origin();
        if (!base) return response;
        const url = new URL(
          response.url || (typeof input === "object" && "url" in input ? input.url : String(input)),
          base,
        );
        if (url.origin === base) {
          const handler = authenticationHandler;
          void Promise.resolve()
            .then(() => {
              if (authenticationHandler === handler) return handler({ force: true });
            })
            .catch((error) => reportDiagnostic("authentication-observer", error));
        }
      }
      return response;
    },
    /** @param {(options?: {force?: boolean}) => unknown} handler */
    observeAuthentication(handler) {
      authenticationHandler = handler;
      return () => {
        if (authenticationHandler === handler) authenticationHandler = null;
      };
    },
    /** @param {{force?: boolean}} [options] */
    checkAuthentication(options) {
      return authenticationHandler?.(options);
    },
  };
}

const client = createHttpClient();
export const request = client.request;
export const observeAuthentication = client.observeAuthentication;
export const checkAuthentication = client.checkAuthentication;
