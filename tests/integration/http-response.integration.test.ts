import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a slow HTTP client receives the complete large RPC response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "panda-slow-response-"));
  const token = "slow-response-test";
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as any).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  writeFileSync(
    join(dir, "codex"),
    `#!${process.execPath}
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  const result = message.method === "thread/read"
    ? { thread: { id: "large", preview: "x".repeat(16 * 1024 * 1024), turns: [] } }
    : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`,
    { mode: 0o700 },
  );
  const server = Bun.spawn(["bun", "run", "src/server/main.ts"], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(?:PANDA_FORCE_|CODEX_|WEBUI_|IDAAS_|OSS_|ALIYUN_)/.test(key)),
      ),
      NODE_ENV: "production",
      HOME: dir,
      PANDA_FORCE_HOME: join(dir, "panda-state"),
      PATH: `${dir}:${process.env.PATH}`,
      CODEX_HOME: dir,
      PANDA_FORCE_CWD: dir,
      PANDA_FORCE_APP_SERVER_MODE: "isolated",
      PANDA_FORCE_AUTH_MODE: "password",
      PANDA_FORCE_PASSWORD: "",
      PANDA_FORCE_ACCESS_TOKEN: token,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  let serverLogs = "";
  void (async () => {
    for await (const chunk of server.stderr) serverLogs = (serverLogs + Buffer.from(chunk).toString()).slice(-12000);
  })();
  let client: ReturnType<typeof Bun.spawn> | undefined;
  try {
    let ready = false;
    let lastHealth: unknown = null;
    for (let i = 0; i < 200; i++) {
      if (server.exitCode !== null) break;
      try {
        const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
          headers: { authorization: `Bearer ${token}` },
        }).then((r) => r.json());
        lastHealth = health;
        if (health.codex) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(25);
    }
    expect(ready, JSON.stringify({ lastHealth, serverExitCode: server.exitCode, serverLogs })).toBe(true);
    // A small TCP receive window prevents buffering the entire response before
    // the pause. Python exposes SO_RCVBUF, unlike Node's TCP Socket API.
    client = Bun.spawn(
      [
        "python3",
        "-u",
        "-c",
        `
import json, re, socket, time, sys
body = json.dumps({"id":7,"method":"thread/read","params":{"threadId":"large","includeTurns":False}}).encode()
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 65536)
s.settimeout(5)
s.connect(("127.0.0.1", ${port}))
s.sendall(b"POST /api/rpc HTTP/1.1\\r\\nHost: localhost\\r\\nAuthorization: Bearer ${token}\\r\\nContent-Type: application/json\\r\\nConnection: keep-alive\\r\\nContent-Length: " + str(len(body)).encode() + b"\\r\\n\\r\\n" + body)
data = b""
while b"\\r\\n\\r\\n" not in data:
    part = s.recv(65536)
    if not part: raise RuntimeError("Missing response headers")
    data += part
headers, data = data.split(b"\\r\\n\\r\\n", 1)
expected = int(re.search(rb"content-length:\\s*(\\d+)", headers, re.I)[1])
time.sleep(12)
received = len(data)
while received < expected:
    data = s.recv(65536)
    if not data: break
    received += len(data)
s.close()
complete = received == expected
print(json.dumps({"expected":expected,"received":received,"complete":complete}))
sys.exit(0 if complete and expected > 16*1024*1024 else 1)
`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(client.stdout).text();
    expect(await client.exited, output).toBe(0);
    const result = JSON.parse(output);
    expect(result.complete).toBe(true);
    expect(result.received).toBe(result.expected);
  } finally {
    if (client && client.exitCode === null) {
      client.kill();
      await client.exited;
    }
    server.kill("SIGTERM");
    await server.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
