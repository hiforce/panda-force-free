import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
/** Component-only browser fixture: real shared styles/i18n, mocked API routes, no business runtime or model process. */
export async function createDatabaseUiFixture() {
  const root = new URL("../..", import.meta.url).pathname,
    out = join(root, ".artifacts/mysql-integration/database-ui");
  await mkdir(out, { recursive: true });
  const entry = join(out, "boundary-entry.ts"),
    bundle = join(out, "boundary-runtime.js");
  await Bun.write(
    entry,
    `import {createDatabaseSettings} from ${JSON.stringify(join(root, "src/client/database/settings.ts"))};import {initializeDatabaseSetup} from ${JSON.stringify(join(root, "src/client/database/bootstrap.ts"))};import {getBrowserI18n} from ${JSON.stringify(join(root, "src/client/i18n.js"))};globalThis.__pandaForceIdentityKey='database-ui-fixture';const i18n=getBrowserI18n();await i18n.ready;createDatabaseSettings(i18n.t).show(document.querySelector('[data-database-view]'));void initializeDatabaseSetup(i18n.t);`,
  );
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    outdir: out,
    naming: "boundary-runtime.js",
    plugins: [
      {
        name: "shared-database-ui-runtime",
        setup(build) {
          build.onResolve({ filter: /(?:i18n|http-client)\.js$/ }, (args) => {
            const path = resolve(args.resolveDir, args.path);
            for (const name of ["i18n.js", "http-client.js"])
              if (path === join(root, "src/client", name)) return { path: "/" + name, external: true };
          });
        },
      },
    ],
  });
  if (!result.success) throw Error("Database component fixture build failed");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/settings/storage" || path === "/") {
        return new Response(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workbench.css"><link rel="stylesheet" href="/workbench-forms.css"><link rel="stylesheet" href="/workbench-layout.css"><link rel="stylesheet" href="/settings-workspace.css"><link rel="stylesheet" href="/appearance.css"><link rel="stylesheet" href="/database.css"><script type="module" src="/boundary-runtime.js"></script></head><body><div class="settings-dialog" data-mobile-page="true"><main class="settings-content" style="height:100dvh"><section class="settings-page"><div data-database-view></div></section></main></div></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (path === "/boundary-runtime.js") return new Response(Bun.file(bundle));
      if (
        /^\/(?:style|workbench|workbench-forms|workbench-layout|settings-workspace|appearance|database)\.css$/.test(
          path,
        ) ||
        ["/i18n.js", "/http-client.js"].includes(path) ||
        /^\/locales\/(en|zh-CN|zh-HK|zh-TW)\.json$/.test(path)
      )
        return new Response(Bun.file(join(root, "public", path.slice(1))));
      return new Response("Not found", { status: 404 });
    },
  });
  return {
    base: server.url.href.slice(0, -1),
    async dispose() {
      server.stop(true);
    },
  };
}

export async function waitForDatabaseUi(check) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw Error("Database UI fixture timed out");
}
