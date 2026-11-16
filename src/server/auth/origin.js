/** Share parsing while retaining the stricter configured origin used by OIDC.
 * @param {{hostHeader?: string; origin?: string; fetchSite?: string | string[]; expectedOrigin?: string | null; allowCrossSiteNavigation?: boolean}} request
 */
export function matchesRequestOrigin({
  hostHeader,
  origin,
  fetchSite = undefined,
  expectedOrigin = null,
  allowCrossSiteNavigation = false,
}) {
  if (!hostHeader || (fetchSite === "cross-site" && !allowCrossSiteNavigation)) return false;
  try {
    if (expectedOrigin && hostHeader.toLowerCase() !== new URL(expectedOrigin).host.toLowerCase()) return false;
    if (!origin) return true;
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) return false;
    return expectedOrigin ? parsed.origin === expectedOrigin : parsed.host.toLowerCase() === hostHeader.toLowerCase();
  } catch {
    return false;
  }
}

/** Cookie-authenticated writes require browser origin evidence; explicit API credentials have a separate gate.
 * @param {import("node:http").IncomingMessage} req
 */
export function matchesCookieMutationOrigin(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method || "")) return true;
  return (
    Boolean(req.headers.origin || req.headers["sec-fetch-site"] === "same-origin") &&
    matchesRequestOrigin({
      hostHeader: req.headers.host,
      origin: req.headers.origin,
      fetchSite: req.headers["sec-fetch-site"],
    })
  );
}
