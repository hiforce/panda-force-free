import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { createIdaasAuth, readIdaasConfig } from '../src/server/auth/idaas.js';

const env = {
  PANDA_FORCE_AUTH_MODE: 'idaas', IDAAS_AUTH_ENDPOINT: 'http://127.0.0.1:8087',
  IDAAS_BROWSER_ENDPOINT: 'https://idaas.example.com', IDAAS_CLIENT_ID: 'panda', IDAAS_CLIENT_SECRET: 'test-only-secret',
  PANDA_FORCE_PUBLIC_URL: 'https://codex.example.com/', IDAAS_ALLOWED_TENANT_IDS: '42', IDAAS_ALLOWED_ACCOUNTS: 'allowed@example.com',
};
const services: ReturnType<typeof createIdaasAuth>[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
function fixture({ tokenSeconds = 1800 } = {}) {
  let clock = 1_800_000_000_000;
  let active = true, unavailable = false, account = 'allowed@example.com', tenantId = 42;
  let introspectionOverride: any = null;
  const calls: { path: string; body: any; headers: any }[] = [];
  const auth = createIdaasAuth(readIdaasConfig(env)!, {
    now: () => clock,
    fetchImpl: async (url: any, init: any) => {
      const path = new URL(url).pathname; calls.push({ path, body: JSON.parse(init.body), headers: init.headers });
      if (unavailable) throw new Error('upstream failed with secret data');
      if (path === '/oidc/token') return Response.json({ success: true, data: { access_token: 'test-access-token', id_token: 'test-id-token', refresh_token: 'unused', expires_in: tokenSeconds } });
      if (path === '/oidc/token/introspection') return Response.json(introspectionOverride || { active, exp: Math.floor(clock / 1000) + tokenSeconds });
      if (path === '/oidc/me') return Response.json({ success: true, data: { uuid: 'user-1', account, tenantId } });
      throw new Error('Unexpected endpoint');
    },
  });
  services.push(auth);
  const req = (cookie = '', headers = {}, method = 'GET') => ({ headers: { host: 'codex.example.com', cookie, ...headers }, socket: { remoteAddress: '127.0.0.1' }, method });
  async function route(path: string, request = req()) {
    const result: any = { status: 0, headers: {}, body: '' };
    const res = { statusCode: 200, writeHead(status: number, headers: any) { this.statusCode = status; result.status = status; result.headers = headers; }, end(body = '') { result.body = body; } };
    result.handled = await auth.handle(request, res, new URL(path, env.PANDA_FORCE_PUBLIC_URL));
    return result;
  }
  async function begin() {
    const response = await route('/auth/login');
    expect(response.status).toBe(303);
    return { state: new URL(response.headers.location).searchParams.get('state')!, cookie: response.headers['set-cookie'][0].split(';')[0], response };
  }
  async function login() {
    const transaction = await begin();
    const response = await route(`/auth/callback?code=test-code&state=${transaction.state}`, req(transaction.cookie, { 'sec-fetch-site': 'cross-site' }));
    return { ...transaction, response, sessionCookie: response.headers['set-cookie']?.[0].split(';')[0] };
  }
  return { auth, calls, req, route, begin, login,
    advance(ms: number) { clock += ms; }, invalidate() { active = false; }, fail() { unavailable = true; }, recover() { unavailable = false; },
    introspection(value: any) { introspectionOverride = value; },
    denyAccount() { account = 'other@example.com'; }, denyTenant() { tenantId = 99; },
  };
}

describe('IDAAS browser authentication', () => {
  test('requires explicit, complete configuration and HTTPS public endpoints', () => {
    expect(readIdaasConfig({})).toBe(null);
    expect(() => readIdaasConfig({ IDAAS_CLIENT_ID: 'partial' })).toThrow();
    expect(() => readIdaasConfig({ ...env, IDAAS_CLIENT_SECRET: '' })).toThrow();
    expect(() => readIdaasConfig({ ...env, PANDA_FORCE_PUBLIC_URL: 'http://codex.example.com' })).toThrow();
    expect(() => readIdaasConfig({ ...env, PANDA_FORCE_PUBLIC_URL: 'https://codex.example.com/subpath/' })).toThrow();
  });
  test('binds state to a browser and accepts the exact cross-site callback once', async () => {
    const f = fixture(); const start = await f.begin();
    const target = new URL(start.response.headers.location);
    expect(target.origin).toBe('https://idaas.example.com');
    expect(target.searchParams.get('redirect_uri')).toBe('https://codex.example.com/auth/callback');
    expect(target.searchParams.get('nonce')).toBeTruthy();
    expect((await f.route(`/auth/callback?code=x&state=${start.state}`)).status).toBe(400);
    expect(f.calls.length).toBe(0);
    const good = await f.route(`/auth/callback?code=x&state=${start.state}`, f.req(start.cookie, { 'sec-fetch-site': 'cross-site' }));
    expect(good.status).toBe(303);
    expect((await f.route(`/auth/callback?code=x&state=${start.state}`, f.req(start.cookie))).status).toBe(400);
    expect(f.calls.filter(c => c.path === '/oidc/token').length).toBe(1);
    expect(f.calls.find(c => c.path === '/oidc/me')!.body).toEqual({});
    expect(f.calls.find(c => c.path === '/oidc/me')!.headers.authorization).toBe('Bearer test-access-token');
  });
  test('rejects expired states, duplicate query parameters and arbitrary code routes', async () => {
    const f = fixture(); const start = await f.begin(); f.advance(300_001);
    expect((await f.route(`/auth/callback?code=x&state=${start.state}`, f.req(start.cookie))).status).toBe(400);
    const next = await f.begin();
    expect((await f.route(`/auth/callback?code=x&code=y&state=${next.state}`, f.req(next.cookie))).status).toBe(400);
    expect((await f.route('/api/config?code=x')).handled).toBe(false);
    expect(f.calls.length).toBe(0);
  });
  test('only grants configured tenants and accounts', async () => {
    for (const deny of ['denyAccount', 'denyTenant'] as const) {
      const f = fixture(); f[deny]();
      expect((await f.login()).response.status).toBe(403);
    }
  });
  test('denied browser callbacks render a localized page without granting a session or exposing OAuth data', async () => {
    const f = fixture(); f.denyAccount();
    const start = await f.begin();
    const response = await f.route(`/auth/callback?code=private-code&state=${start.state}`,
      f.req(start.cookie, { accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }));
    expect(response.status).toBe(403);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("form-action 'self' https://idaas.example.com");
    expect(response.headers['referrer-policy']).toBe('strict-origin');
    expect(response.body).toContain('<html lang="zh-CN">');
    expect(response.body).toContain('暂时无法访问');
    expect(response.body).toContain('method="post" action="/auth/relogin"');
    for (const secret of ['private-code', start.state, 'test-access-token', 'test-only-secret', 'other@example.com'])
      expect(response.body).not.toContain(secret);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(JSON.parse((await f.route('/api/auth/status', f.req(start.cookie))).body).authenticated).toBe(false);
  });
  test('navigation headers select HTML while API errors keep the JSON contract', async () => {
    const f = fixture();
    const document = await f.route('/auth/callback?error=untrusted-message', f.req('', { 'sec-fetch-dest': 'document', 'accept-language': 'en;q=1,zh;q=0.5' }));
    expect(document.status).toBe(400);
    expect(document.body).toContain('<html lang="en">');
    expect(document.body).not.toContain('untrusted-message');
    const { sessionCookie } = await f.login(); f.advance(300_001); f.fail();
    const api = await f.route('/api/auth/status', f.req(sessionCookie, { accept: 'text/html' }));
    expect(api.status).toBe(503);
    expect(api.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(api.body)).toEqual({ error: 'IDAAS is unavailable; try again later', loginUrl: '/auth/login' });
  });
  test('relogin clears local sessions and stale state, then logs out of IDAAS before starting a fresh fixed callback', async () => {
    const f = fixture(); const { sessionCookie } = await f.login();
    const session = await f.auth.authenticate(f.req(sessionCookie)); let closed = false;
    f.auth.watch(session.id, () => { closed = true; });
    const stale = await f.begin();
    const response = await f.route('/auth/relogin?redirectUri=https://evil.example',
      f.req(`${sessionCookie}; ${stale.cookie}`, { origin: 'https://codex.example.com' }, 'POST'));
    expect(response.status).toBe(303);
    const logout = new URL(response.headers.location);
    expect(logout.origin).toBe('https://idaas.example.com');
    expect(logout.pathname).toBe('/logout');
    expect([...logout.searchParams.entries()]).toEqual([['redirectUri', 'https://codex.example.com/auth/login']]);
    expect(response.headers['set-cookie']).toEqual([
      'panda_force_idaas_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
      'panda_force_idaas_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    ]);
    expect(closed).toBe(true);
    expect(JSON.parse((await f.route('/api/auth/status', f.req(sessionCookie))).body).authenticated).toBe(false);
    expect((await f.route(`/auth/callback?code=old&state=${stale.state}`, f.req(stale.cookie))).status).toBe(400);
    const fresh = await f.route(new URL(logout.searchParams.get('redirectUri')!).pathname);
    const authorize = new URL(fresh.headers.location);
    expect(authorize.pathname).toBe('/oidc/auth');
    expect(authorize.searchParams.get('state')).not.toBe(stale.state);
    expect(authorize.searchParams.get('nonce')).not.toBe(new URL(stale.response.headers.location).searchParams.get('nonce'));
    expect(authorize.searchParams.get('client_id')).toBe('panda');
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://codex.example.com/auth/callback');
    expect(authorize.searchParams.get('protocol')).toBe('oidc');
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('response_mode')).toBe('query');
  });
  test('relogin works without a granted PandaForce session and rejects cross-site or GET logout attempts', async () => {
    const f = fixture(); const { sessionCookie } = await f.login();
    expect((await f.route('/auth/relogin', f.req(sessionCookie))).status).toBe(405);
    expect((await f.route('/auth/relogin', f.req(sessionCookie, { origin: 'https://evil.example' }, 'POST'))).status).toBe(403);
    expect(JSON.parse((await f.route('/api/auth/status', f.req(sessionCookie))).body).authenticated).toBe(true);
    const anonymous = await f.route('/auth/relogin', f.req('', { origin: 'https://codex.example.com' }, 'POST'));
    expect(anonymous.status).toBe(303);
    expect(new URL(anonymous.headers.location).pathname).toBe('/logout');
  });
  test('uses an opaque secure cookie, bounded expiry and excludes tokens from status', async () => {
    const f = fixture({ tokenSeconds: 180 }); const { response, sessionCookie } = await f.login();
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly; SameSite=Lax; Max-Age=180; Secure');
    expect(sessionCookie).not.toContain('test-access-token');
    const status = await f.route('/api/auth/status', f.req(sessionCookie));
    expect(JSON.parse(status.body).identity).toEqual({ uuid: 'user-1', tenantId: '42', account: 'allowed@example.com' });
    expect(status.body).not.toContain('test-access-token');
    expect(status.body).not.toContain('test-only-secret');
    f.advance(180_001);
    expect(JSON.parse((await f.route('/api/auth/status', f.req(sessionCookie))).body).authenticated).toBe(false);
  });
  test('caches concurrent checks, revalidates revocation and closes attached connections', async () => {
    const f = fixture(); const { sessionCookie } = await f.login();
    const session = await f.auth.authenticate(f.req(sessionCookie)); let closed = 0;
    f.auth.watch(session.id, () => { closed++; });
    await Promise.all(Array.from({ length: 10 }, () => f.auth.authenticate(f.req(sessionCookie))));
    expect(f.calls.filter(c => c.path.includes('introspection')).length).toBe(1);
    f.advance(30_001);
    await f.auth.authenticate(f.req(sessionCookie));
    expect(f.calls.filter(c => c.path.includes('introspection')).length).toBe(1);
    f.advance(270_000);
    await Promise.all(Array.from({ length: 10 }, () => f.auth.authenticate(f.req(sessionCookie))));
    expect(f.calls.filter(c => c.path.includes('introspection')).length).toBe(2);
    f.advance(300_001); f.invalidate();
    await expect(f.auth.authenticate(f.req(sessionCookie))).rejects.toHaveProperty('status', 401);
    await Bun.sleep(1); expect(closed).toBe(1);
  });
  test('fails closed on upstream outages without exposing details', async () => {
    const f = fixture(); const { sessionCookie } = await f.login(); f.advance(300_001); f.fail();
    const warnings = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const status = await f.route('/api/auth/status', f.req(sessionCookie));
      expect(status.status).toBe(503); expect(status.body).not.toContain('secret data');
      const entries = warnings.mock.calls.map(([event, detail]) => ({event, detail: JSON.parse(detail)}));
      expect(entries).toHaveLength(2);
      expect(entries[0].event).toBe('[panda-force] auth/provider-request');
      expect(entries[0].detail).toMatchObject({operation:'/oidc/token/introspection',outcome:'unavailable',httpStatus:null});
      expect(entries[0].detail.durationMs).toBeGreaterThanOrEqual(0);
      expect(entries[1].event).toBe('[panda-force] auth/status-request');
      expect(entries[1].detail.httpStatus).toBe(503);
      const logged = JSON.stringify(warnings.mock.calls);
      for (const secret of ['test-access-token','test-only-secret','secret data','allowed@example.com']) expect(logged).not.toContain(secret);
    } finally { warnings.mockRestore(); }
  });
  test('background verification suspends channels during an outage without deleting the login', async () => {
    const f = fixture(); const { sessionCookie } = await f.login();
    const session = await f.auth.authenticate(f.req(sessionCookie)); let closed = 0;
    f.auth.watch(session.id, () => { closed++; });
    f.advance(300_001); f.fail();
    for (let n = 0; n < 110 && !closed; n++) await Bun.sleep(50);
    expect(closed).toBe(1);
    expect((await f.route('/api/auth/status', f.req(sessionCookie))).status).toBe(503);
    f.recover();
    const recovered = await f.route('/api/auth/status', f.req(sessionCookie));
    expect(JSON.parse(recovered.body).authenticated).toBe(true);
    expect(recovered.headers['set-cookie']).toBeUndefined();
    // Recovery does not extend the original token/session deadline.
    f.advance(1_500_001);
    expect(JSON.parse((await f.route('/api/auth/status', f.req(sessionCookie))).body).authenticated).toBe(false);
  }, 10000);
  test('ambiguous or malformed provider results do not masquerade as a user sign-out', async () => {
    for (const result of [{}, { success: false }, { active: true }, { active: 'false', exp: 1_900_000_000 }]) {
      const f = fixture(); const { sessionCookie } = await f.login();
      f.advance(300_001); f.introspection(result);
      expect((await f.route('/api/auth/status', f.req(sessionCookie))).status).toBe(503);
      f.introspection(null);
      expect(JSON.parse((await f.route('/api/auth/status', f.req(sessionCookie))).body).authenticated).toBe(true);
    }
  });
  test('the requested return page is bound to the login transaction', async () => {
    const f = fixture();
    const path = '/task/thread-123?view=changes#latest';
    const start = await f.route('/auth/login?returnTo=' + encodeURIComponent(path));
    const state = new URL(start.headers.location).searchParams.get('state');
    const cookie = start.headers['set-cookie'][0].split(';')[0];
    const callback = await f.route(`/auth/callback?code=x&state=${state}&returnTo=https://evil.example`, f.req(cookie));
    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe(path);
    const unsafe = await f.route('/auth/login?returnTo=' + encodeURIComponent('//evil.example'));
    const unsafeState = new URL(unsafe.headers.location).searchParams.get('state');
    const unsafeCookie = unsafe.headers['set-cookie'][0].split(';')[0];
    expect((await f.route(`/auth/callback?code=x&state=${unsafeState}`, f.req(unsafeCookie))).headers.location).toBe('/');
  });
  test('rejects cross-site access and legacy login even from localhost', async () => {
    const f = fixture(); const { sessionCookie } = await f.login();
    await expect(f.auth.authenticate(f.req(sessionCookie, { origin: 'https://evil.example' }))).rejects.toHaveProperty('status', 403);
    await expect(f.auth.authenticate(f.req(''))).rejects.toHaveProperty('status', 401);
    expect((await f.route('/api/auth/login', f.req('', {}, 'POST'))).status).toBe(404);
    expect((await f.route('/api/auth/setup', f.req('', {}, 'POST'))).status).toBe(404);
  });
  test('logout invalidates sessions and connections; global logout uses the correct endpoint', async () => {
    const f = fixture(); const { sessionCookie } = await f.login();
    const session = await f.auth.authenticate(f.req(sessionCookie)); let closed = false;
    f.auth.watch(session.id, () => { closed = true; });
    expect((await f.route('/api/auth/logout', f.req(sessionCookie))).status).toBe(405);
    expect((await f.route('/api/auth/logout', f.req(sessionCookie, { origin: 'https://evil.example' }, 'POST'))).status).toBe(403);
    const logout = await f.route('/api/auth/logout?global=true', f.req(sessionCookie, {}, 'POST'));
    const url = new URL(JSON.parse(logout.body).logoutUrl);
    expect(url.pathname).toBe('/oidc/logout'); expect(url.searchParams.get('redirect_uri')).toBe('https://codex.example.com/auth/logged-out');
    expect(closed).toBe(true);
    expect(JSON.parse((await f.route('/api/auth/status', f.req(sessionCookie))).body).authenticated).toBe(false);
  });
});
