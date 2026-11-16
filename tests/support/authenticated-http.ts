/** Owns a disposable client's cookies without reading any host or application credentials. */
export function authenticatedHttp(base: string) {
  const cookies = new Map<string, string>();
  async function request(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        cookie: [...cookies.values()].join("; "),
        "content-type": body instanceof Uint8Array ? "application/octet-stream" : "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      cookies.set(pair.split("=")[0]!, pair);
    }
    return response;
  }
  async function json<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await request(path, body, method);
    if (!response.ok) throw Error(`Fixture HTTP ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
  return {
    request,
    json,
    async signIn() {
      await json("/api/auth/login", { username: "fixture-owner", password: "visibility-test" });
      await json("/api/auth/setup", { username: "fixture-owner" });
    },
  };
}
