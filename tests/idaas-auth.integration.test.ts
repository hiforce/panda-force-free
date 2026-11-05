import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import WebSocket from 'ws';

async function freePort() {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as any).port; await new Promise<void>(resolve => probe.close(() => resolve())); return port;
}
function openSocket(url: string, cookie = '') {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie } });
    ws.once('open', () => resolve(ws)); ws.once('error', reject);
    ws.once('unexpected-response', (_req, response) => {
      response.resume(); ws.terminate();
      reject(new Error(response.headers['www-authenticate'] ? 'Unexpected browser-native authentication challenge' : String(response.statusCode)));
    });
  });
}

test('IDAAS gates HTTP, both WS bridges and SSE, preserves probes and closes sessions on logout', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'panda-idaas-')); const bin = join(temp, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), '#!/usr/bin/env node\nprocess.stdin.resume();\n', { mode: 0o700 });
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/oidc/token') return Response.json({ success: true, data: { access_token: 'mock-access', id_token: 'mock-id', expires_in: 120 } });
    if (path === '/oidc/token/introspection') return Response.json({ active: true, exp: Math.floor(Date.now() / 1000) + 120 });
    if (path === '/oidc/me') return Response.json({ success: true, data: { uuid: 'owner', tenantId: 42, account: 'owner' } });
    return new Response('Not found', { status: 404 });
  } });
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(['bun', 'run', 'src/server/main.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: temp, CODEX_HOME: temp, HOST: '127.0.0.1', PORT: String(port),
      PANDA_FORCE_CWD: temp, PANDA_FORCE_PROJECTLESS: 'false', PANDA_FORCE_AUTH_MODE: 'idaas',
      PANDA_FORCE_PASSWORD: 'must-not-be-a-backdoor', PANDA_FORCE_ACCESS_TOKEN: 'must-not-be-a-backdoor',
      IDAAS_AUTH_ENDPOINT: upstream.url.origin, IDAAS_BROWSER_ENDPOINT: upstream.url.origin, IDAAS_CLIENT_ID: 'test', IDAAS_CLIENT_SECRET: 'test-only',
      PANDA_FORCE_PUBLIC_URL: base, IDAAS_ALLOWED_TENANT_IDS: '42', IDAAS_ALLOWED_ACCOUNTS: 'owner' }, stdout: 'ignore', stderr: 'pipe',
  });
  let ws: WebSocket | null = null, terminal: WebSocket | null = null;
  try {
    let ready = false;
    for (let i = 0; i < 500; i++) {
      try { if ((await fetch(base + '/health/startup')).ok) { ready = true; break; } } catch {}
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      await Bun.sleep(30);
    }
    expect(ready).toBe(true);
    expect((await fetch(base + '/health/liveness')).status).toBe(200);
    expect((await fetch(base + '/health/readiness')).status).toBe(503);
    expect((await fetch(base + '/health/liveness', { method: 'POST' })).status).toBe(405);
    for (const path of ['/api/config', '/api/events', '/app.bundle.js']) expect((await fetch(base + path, { headers: { authorization: 'Bearer must-not-be-a-backdoor' } })).status).toBe(401);
    expect((await fetch(base, { redirect: 'manual' })).headers.get('location')).toBe('/auth/login');
    await expect(openSocket(`ws://127.0.0.1:${port}/ws`)).rejects.toThrow('401');
    await expect(openSocket(`ws://127.0.0.1:${port}/terminal`)).rejects.toThrow('401');
    const login = await fetch(base + '/auth/login', { redirect: 'manual' });
    const state = new URL(login.headers.get('location')!).searchParams.get('state');
    const binding = login.headers.getSetCookie()[0].split(';')[0];
    const callback = await fetch(`${base}/auth/callback?code=mock-code&state=${state}`, { redirect: 'manual', headers: { cookie: binding, 'sec-fetch-site': 'cross-site' } });
    expect(callback.status).toBe(303); const cookie = callback.headers.getSetCookie()[0].split(';')[0];
    expect((await fetch(base + '/api/config', { headers: { cookie } })).status).toBe(200);
    ws = await openSocket(`ws://127.0.0.1:${port}/ws`, cookie);
    // The test machine may not have a compiled PTY addon, but its handshake is still authenticated.
    terminal = await openSocket(`ws://127.0.0.1:${port}/terminal`, cookie);
    const events = await fetch(base + '/api/events', { headers: { cookie } }); expect(events.status).toBe(200);
    const closed = new Promise<void>(resolve => ws!.once('close', () => resolve()));
    expect((await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie } })).status).toBe(200);
    await Promise.race([closed, Bun.sleep(2000).then(() => { throw new Error('WS remained open after logout'); })]);
    expect((await fetch(base + '/api/config', { headers: { cookie } })).status).toBe(401);
    await events.body?.cancel();
  } finally {
    ws?.terminate(); terminal?.terminate(); child.kill('SIGTERM'); await child.exited;
    upstream.stop(true); rmSync(temp, { recursive: true, force: true });
  }
}, 30000);
