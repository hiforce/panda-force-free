// Only return to application pages on this origin, never an OAuth/API endpoint.
export function safeAuthReturnPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !value.startsWith("/") ||
    /[\\\u0000-\u0020\u007f]/.test(value)
  )
    return "/";
  try {
    const origin = "https://panda-force.invalid";
    const url = new URL(value, origin);
    if (
      url.origin !== origin ||
      !/^\/(?:settings(?:\/[^/]+)?|workspace|tasks|projects|project|deliverables|connections|new|task\/[^/]+)?\/?$/.test(
        url.pathname,
      )
    )
      return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}

export function sessionLoginUrl(returnTo) {
  const path = safeAuthReturnPath(returnTo);
  return path === "/" ? "/auth/login" : "/auth/login?returnTo=" + encodeURIComponent(path);
}
