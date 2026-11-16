import type { RouteContext } from "../../http/router.js";
import type { OAuthAttemptPhase } from "../oauth/attempts.js";
import { serverTranslator } from "../../i18n/messages.js";
import { requestLocale } from "../../i18n/request-locale.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { PANDA_ICON_DATA_URL, pandaForceMark } from "../../../shared/brand.js";

/** The callback redirects here without carrying authorization codes, state or provider error text. */
export function sendConsentResult(
  context: RouteContext,
  result: { phase: OAuthAttemptPhase; projectId?: string; id?: string },
) {
  const locale = requestLocale(context.req),
    t = serverTranslator(locale);
  const message =
    result.phase === "complete"
      ? "accounts.resultComplete"
      : result.phase === "verifying"
        ? "accounts.resultVerifying"
        : result.phase === "failed"
          ? "accounts.resultFailed"
          : "accounts.resultPending";
  context.res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "strict-origin",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  context.res
    .end(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><link rel="icon" href="${PANDA_ICON_DATA_URL}"><title>${e(t("accounts.resultTitle"))} · PandaForce</title><style>
    :root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif;background:light-dark(#f6f7f9,#17191c);color:light-dark(#24272b,#eceef2)}*{box-sizing:border-box}body{margin:0;padding:24px;min-height:100svh;display:grid;place-items:center}main{width:min(100%,480px);padding:32px;border:1px solid light-dark(#e1e4ea,#393d44);border-radius:20px;background:light-dark(#fff,#22252a)}header{display:flex;align-items:center;gap:10px;font-weight:600}.mark{display:block;width:28px;height:28px}.mark svg{width:100%;height:100%;display:block}h1{font-size:24px;margin:28px 0 12px}p{margin:0 0 24px}a,button{display:block;width:100%;text-align:center;padding:12px 16px;border:1px solid light-dark(#d4d8e0,#4a505a);border-radius:10px;color:inherit;background:transparent;text-decoration:none;font:inherit;cursor:pointer;margin-top:12px}a:focus-visible,button:focus-visible{outline:3px solid #7a8bff;outline-offset:3px}</style></head><body><main><header><span class="mark" aria-hidden="true">${pandaForceMark()}</span>PandaForce</header><h1>${e(t("accounts.resultTitle"))}</h1><p role="status">${e(t(message))}</p>
    ${result.phase === "verifying" && result.id ? `<form method="post" action="/api/publication-accounts/verify-return"><input type="hidden" name="id" value="${e(result.id)}"><button type="submit">${e(t("accounts.retryVerification"))}</button></form>` : ""}
    <a href="${result.projectId ? `/documents?project=${encodeURIComponent(result.projectId)}` : "/workspace"}">${e(t(result.projectId ? "accounts.returnProject" : "accounts.returnWorkspace"))}</a></main></body></html>`);
}
