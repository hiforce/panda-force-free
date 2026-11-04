import { PANDA_ICON_DATA_URL, pandaForceMark } from "../../shared/brand.js";

const COPY = {
  en: {
    denied: {
      label: "Access restricted",
      title: "This account needs access",
      description: "Your account has not been granted access to this workspace.",
      help: "Sign in with an authorized account, or contact your workspace administrator to request access.",
    },
    incomplete: {
      label: "Sign-in incomplete",
      title: "Let's try signing in again",
      description: "We couldn't complete this sign-in. The login link may have expired.",
      help: "Start a new sign-in to continue to your workspace.",
    },
    rejected: {
      label: "Sign-in unsuccessful",
      title: "We couldn't verify this request",
      description: "Please start a new sign-in from PandaForce.",
      help: "If this keeps happening, contact your workspace administrator.",
    },
    limited: {
      label: "Please try again later",
      title: "Too many sign-in attempts",
      description: "There have been too many sign-in attempts. Please wait a few minutes.",
      help: "You can start a new sign-in once the temporary limit has cleared.",
    },
    unavailable: {
      label: "Temporarily unavailable",
      title: "Sign-in is unavailable",
      description: "The sign-in service is currently unavailable.",
      help: "Please try again in a moment. If the issue continues, contact your workspace administrator.",
    },
    signedOut: {
      label: "Signed out",
      title: "See you next time",
      description: "You have signed out of PandaForce.",
      help: "Sign in again whenever you're ready to continue.",
    },
    action: "Sign in again",
    continue: "Sign in",
    footer: "Your workspace, when you're ready.",
  },
  "zh-CN": {
    denied: {
      label: "访问受限",
      title: "暂时无法访问",
      description: "当前账号尚未获得此工作区的访问权限。",
      help: "请使用已获授权的账号重新登录，或联系工作区管理员开通权限。",
    },
    incomplete: {
      label: "登录未完成",
      title: "请重新登录",
      description: "这次登录未能完成，登录链接可能已过期。",
      help: "重新发起登录，即可继续访问你的工作区。",
    },
    rejected: {
      label: "登录未完成",
      title: "暂时无法验证此请求",
      description: "请从 PandaForce 重新发起登录。",
      help: "如果问题持续出现，请联系工作区管理员。",
    },
    limited: {
      label: "请稍后重试",
      title: "稍等片刻，再试一次",
      description: "登录尝试次数较多，请稍后重新登录。",
      help: "短暂等待后，你就可以重新发起登录。",
    },
    unavailable: {
      label: "服务暂不可用",
      title: "暂时无法完成登录",
      description: "登录服务暂时不可用，请稍后重试。",
      help: "如果问题持续出现，请联系工作区管理员。",
    },
    signedOut: {
      label: "已退出登录",
      title: "下次见",
      description: "你已退出 PandaForce。",
      help: "准备好后，随时登录继续使用。",
    },
    action: "重新登录",
    continue: "登录",
    footer: "准备好后，随时继续。",
  },
};

export function authPageLanguage(req) {
  const languages = String(req.headers["accept-language"] || "")
    .split(",")
    .map((entry, index) => {
      const [language, ...options] = entry.trim().split(";");
      const quality = options.find((option) => option.trim().startsWith("q="));
      return { language, index, quality: quality ? Number(quality.trim().slice(2)) : 1 };
    })
    .filter((entry) => /^(zh|en)(?:-|$)/i.test(entry.language) && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return /^zh/i.test(languages[0]?.language || "") ? "zh-CN" : "en";
}

// A self-contained document: it must render before any app assets or scripts
// can be accessed. Only fixed copy is included; OAuth errors and tokens stay out.
export function sendAuthPage(res, { kind, status, language = "en", idaasOrigin = "" }) {
  const copy = COPY[language] || COPY.en;
  const content = copy[kind] || copy.unavailable;
  const signedOut = kind === "signedOut";
  const icon = signedOut
    ? '<path d="m8 12 2.5 2.5L16 9"/>'
    : '<rect x="6.5" y="10" width="11" height="9" rx="2.5"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/><path d="M12 14v1"/>';
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    vary: "Accept, Accept-Language, Sec-Fetch-Dest",
    "x-content-type-options": "nosniff",
    // Keep the POST's Origin for CSRF checks without forwarding callback query
    // parameters. no-referrer makes browsers submit these forms with Origin:null.
    "referrer-policy": "strict-origin",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'${idaasOrigin ? ` ${idaasOrigin}` : ""}`,
  });
  res.end(`<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="${PANDA_ICON_DATA_URL}">
<title>${content.label} · PandaForce</title>
<style>
:root{color-scheme:light dark;--page:#f7f8fa;--card:#fff;--ink:#24272b;--muted:#737880;--border:#e9ebee;--soft:#f4f5f7;--button:#26292d;--button-ink:#fff;--shadow:0 8px 40px #1c263307}
*{box-sizing:border-box}body{margin:0;min-height:100svh;background:var(--page);color:var(--ink);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.page{min-height:100svh;display:flex;flex-direction:column;padding:30px 40px 24px}.brand{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;letter-spacing:-.3px}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--border);border-radius:9px;background:var(--card)}svg{display:block}.brand-mark .panda-force-mark{display:block;width:22px;height:22px;--panda-eye:var(--card)}.brand-mark svg{width:100%;height:100%}.stage{flex:1;display:grid;place-items:center;padding:52px 0 76px}.card{width:100%;max-width:448px;padding:38px 36px 26px;background:var(--card);border:1px solid var(--border);border-radius:22px;box-shadow:var(--shadow)}.status-icon{width:54px;height:54px;display:grid;place-items:center;background:var(--soft);border:1px solid var(--border);border-radius:17px;margin-bottom:26px}.label{margin:0 0 8px;color:var(--muted);font-size:12px;font-weight:500;letter-spacing:.04em}h1{font-size:27px;line-height:1.4;font-weight:600;letter-spacing:-.8px;margin:0 0 14px;text-wrap:balance}.description{margin:0;color:var(--ink);font-size:15px;line-height:1.8}.help{margin:10px 0 28px;color:var(--muted);font-size:14px;line-height:1.85}form{margin:0}.action{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:48px;padding:11px 20px;border:1px solid transparent;border-radius:11px;background:var(--button);color:var(--button-ink);font-family:inherit;font-size:14px;font-weight:550;text-decoration:none;cursor:pointer;transition:opacity .15s}.action:hover{opacity:.87}.action:focus-visible{outline:3px solid #658bbb;outline-offset:4px}.action svg{flex-shrink:0}.status{margin-top:26px;padding-top:19px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11px;letter-spacing:.02em}.dot{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.55}.footer{text-align:center;font-size:12px;color:var(--muted)}
@media(prefers-color-scheme:dark){:root{--page:#171819;--card:#202123;--ink:#f0f1f2;--muted:#a0a4ab;--border:#303235;--soft:#292b2e;--button:#ededee;--button-ink:#222427;--shadow:0 10px 44px #00000018}}
@media(max-width:520px){.page{padding:24px 20px 20px}.stage{padding:38px 0 54px}.card{padding:30px 26px 22px;border-radius:19px}h1{font-size:25px}.status-icon{margin-bottom:24px}.help{margin-bottom:26px}}
@media(prefers-reduced-motion:reduce){.action{transition:none}}
</style>
</head>
<body>
<div class="page">
<header class="brand"><span class="brand-mark" aria-hidden="true">${pandaForceMark()}</span>PandaForce</header>
<div class="stage"><main class="card" aria-labelledby="auth-title" aria-describedby="auth-description">
<div class="status-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></div>
<p class="label">${content.label}</p>
<h1 id="auth-title">${content.title}</h1>
<p class="description" id="auth-description">${content.description}</p>
<p class="help">${content.help}</p>
${signedOut ? '<a class="action" href="/auth/login">' : '<form method="post" action="/auth/relogin"><button class="action" type="submit">'}${signedOut ? copy.continue : copy.action}<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>${signedOut ? "</a>" : "</button></form>"}
<div class="status">${signedOut ? "PandaForce" : `<span>${status}</span><span class="dot" aria-hidden="true"></span><span>${content.label}</span>`}</div>
</main></div>
<footer class="footer">${copy.footer}</footer>
</div>
</body>
</html>`);
}
