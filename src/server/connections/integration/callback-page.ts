import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { serverTranslator } from "../../i18n/messages.js";
import { requestLocale } from "../../i18n/request-locale.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { PANDA_ICON_DATA_URL } from "../../../shared/brand.js";

/** A public static handoff, not an authentication bypass. The token exchange requires a same-origin authenticated POST. */
export function servePublicationCallback(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method !== "GET" || url.pathname !== "/api/publication-accounts/x/callback") return false;
  const locale = requestLocale(req),
    t = serverTranslator(locale),
    nonce = randomBytes(18).toString("base64");
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "strict-origin",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'`,
  });
  res.end(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><link rel="icon" href="${PANDA_ICON_DATA_URL}"><title>${e(t("accounts.resultTitle"))} · PandaForce</title><style>body{font:16px/1.7 system-ui,sans-serif;margin:0;padding:24px;min-height:85svh;display:grid;place-items:center}main{max-width:440px}h1{font-size:24px}a{color:inherit}#failed[hidden]{display:none}</style></head><body><main><h1>PandaForce · ${e(t("accounts.resultTitle"))}</h1><p id="progress" role="status">${e(t("delivery.working"))}</p><p id="failed" role="alert" hidden>${e(t("accounts.resultFailed"))}</p><noscript>${e(t("accounts.resultFailed"))}</noscript><a href="/workspace">${e(t("accounts.returnWorkspace"))}</a></main>
    <script nonce="${nonce}">
    (async()=>{
      const query=new URLSearchParams(location.search);
      history.replaceState(null,"","/api/publication-accounts/x/callback");
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),40000);
      try {
        const response=await fetch("/api/publication-accounts/x/complete",{method:"POST",signal:controller.signal,credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({state:query.get("state")||"",code:query.get("code")||"",denied:query.has("error")})});
        if(!response.ok)throw new Error("Authorization incomplete");
        const result=await response.json();
        if(typeof result.redirect!=="string"||!/^\\/api\\/publication-accounts\\/authorization-result(?:\\?id=[a-f0-9-]{36})?$/.test(result.redirect))throw new Error("Invalid result destination");
        location.replace(result.redirect);
      }catch{document.getElementById("progress").hidden=true;document.getElementById("failed").hidden=false;}finally{clearTimeout(timer);}
    })();
    </script></body></html>`);
  return true;
}
