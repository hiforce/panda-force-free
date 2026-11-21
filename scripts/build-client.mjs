import { CLIENT_ENTRYPOINTS, CLIENT_BUNDLES } from "../src/shared/client-entrypoints.js";
import { syncCatalogModules } from "./i18n/catalog-modules.mjs";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { SUPPORTED_LOCALES } from "../src/shared/i18n/locale-policy.js";
import { assertPublishedCatalogs } from "./i18n/published-catalogs.mjs";
import { clientStyles } from "./client-styles.mjs";

clientStyles(true);

rmSync("dist/cdn-public", { recursive: true, force: true });
syncCatalogModules();
assertPublishedCatalogs();
const gadgetStyles = [
  "src/client/gadget/style.css",
  ...Array.from(new Bun.Glob("**/*.css").scanSync({ cwd: "src/gadget/system" }))
    .sort()
    .map((path) => "src/gadget/system/" + path),
];
writeFileSync("public/gadget.css", gadgetStyles.map((path) => readFileSync(path, "utf8")).join("\n"));
const revision = createHash("sha256");
mkdirSync("public/locales", { recursive: true });
for (const locale of SUPPORTED_LOCALES) {
  const directory = `src/shared/i18n/locales/${locale.code}`;
  const messages = Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => [name.slice(0, -5), JSON.parse(readFileSync(directory + "/" + name, "utf8"))]),
  );
  const bytes = JSON.stringify(messages);
  revision.update(bytes);
  writeFileSync(`public/locales/${locale.code}.json`, bytes);
}
const localeVersion = revision.digest("hex").slice(0, 16);
const options = {
  target: "browser",
  minify: true,
  define: { PANDA_LOCALE_VERSION: JSON.stringify(localeVersion) },
};
const sharedRuntime = {
  name: "shared-i18n-runtime",
  setup(build) {
    build.onResolve({ filter: /(?:^|\/)(?:i18n|http-client)\.js$/ }, (args) => {
      if (
        args.kind !== "entry-point" &&
        ["i18n.js", "http-client.js"].some(
          (name) => resolve(args.resolveDir, args.path) === resolve("src/client/" + name),
        )
      )
        return {
          path: "/" + args.path.split("/").at(-1) + (args.path.endsWith("/i18n.js") ? "?v=" + localeVersion : ""),
          external: true,
        };
    });
  },
};
for (const [entry, output] of Object.entries(CLIENT_ENTRYPOINTS)) {
  const result = await Bun.build({
    ...options,
    entrypoints: ["src/client/" + entry],
    outdir: "public",
    naming: output,
    plugins: ["i18n.js", "http-client.js"].includes(entry) ? [] : [sharedRuntime],
    external: [
      ...CLIENT_BUNDLES,
      ...CLIENT_BUNDLES.flatMap((path) => [1, 2, 3].map((entry) => path + "?retry=" + entry)),
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "Client build failed: " + entry);
}

if (process.env.PANDA_FORCE_CDN_BASE_URL) {
  const { buildCdn } = await import("./cdn/build.mjs");
  await buildCdn();
}
