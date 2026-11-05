import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = new URL("../..", import.meta.url).pathname;
function imageDefaults(file: string) {
  const source = readFileSync(join(root, file), "utf8").replace(/\\\r?\n/g, " ");
  const values: Record<string, string> = {};
  for (const line of source.split("\n"))
    if (line.startsWith("ENV "))
      for (const match of line.slice(4).matchAll(/(\w+)=([^\s]+)/g)) values[match[1]] = match[2];
  return values;
}
test("both real image configurations let legacy runtime values override image defaults; explicit new settings win", async () => {
  const dir = mkdtempSync(join(tmpdir(), "panda-image-env-")),
    socket = join(dir, "control.sock");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const evaluate = (defaults: Record<string, string>, settings: Record<string, string>) => {
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (key.startsWith("PANDA_FORCE_") || key.startsWith("CODEX_WEBUI_")) delete env[key];
      const source =
        'import {config} from "./src/server/config.ts";import {resolveAppServerConnection} from "./src/server/bridge/app-server-connection.js";console.log(JSON.stringify({cwd:config.defaultCwd,mode:resolveAppServerConnection(process.env,config.homeDir).mode}));';
      const child = Bun.spawnSync([process.execPath, "-e", source], {
        cwd: root,
        env: { ...env, ...defaults, ...settings },
      });
      if (child.exitCode !== 0) throw Error(child.stderr.toString());
      return JSON.parse(child.stdout.toString());
    };
    for (const file of ["Dockerfile", "release/community/Dockerfile"]) {
      const defaults = imageDefaults(file);
      const legacy = {
        CODEX_WEBUI_APP_SERVER_MODE: "shared",
        CODEX_WEBUI_APP_SERVER_SOCKET: socket,
        CODEX_WEBUI_CWD: "/legacy-workspace",
      };
      expect(evaluate(defaults, legacy)).toEqual({ mode: "shared", cwd: "/legacy-workspace" });
      expect(
        evaluate(defaults, {
          ...legacy,
          PANDA_FORCE_APP_SERVER_MODE: "isolated",
          PANDA_FORCE_CWD: "/canonical-workspace",
        }),
      ).toEqual({ mode: "isolated", cwd: "/canonical-workspace" });
      expect(evaluate(defaults, {})).toEqual({ mode: "isolated", cwd: "/home/codex/workspace" });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
