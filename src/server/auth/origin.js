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
