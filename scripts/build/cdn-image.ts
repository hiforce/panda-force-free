const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** Select the current checkout's prepared artifact; reusable build settings contain no pinned revision. */
export function renderCdnDockerfile(options: {
  repository: string;
  baseUrl: string;
  commit: string;
  sourceSha256: string;
}) {
  if (!/^[a-z0-9][a-z0-9._:/-]+$/.test(options.repository) || options.repository.endsWith("/"))
    throw Error("Invalid CDN image repository");
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
    throw Error("Invalid CDN base URL");
  if (!/^[a-f0-9]{40}$/.test(options.commit) || !/^[a-f0-9]{64}$/.test(options.sourceSha256))
    throw Error("Invalid CDN source identity");
  const image = options.repository + ":cdn-" + options.commit.slice(0, 12);
  const guard = [
    "import {readFileSync} from 'node:fs';",
    "import {inspectCompiledCdn} from './src/server/http/cdn-policy.ts';",
    "const info=JSON.parse(readFileSync('/app/build-info.json','utf8'));",
    `if(info.source.sha256!==${JSON.stringify(options.sourceSha256)})throw Error('Prepared CDN image differs from the current source');`,
    `inspectCompiledCdn('/app/public',${JSON.stringify({ required: true, baseUrl: base.href.replace(/\/$/, "") })});`,
    "console.log('Source-matched CDN artifact verified');",
  ].join("");
  return `FROM ${image}\nRUN bun --eval ${shellQuote(guard)}\nLABEL org.opencontainers.image.revision="${options.commit}"\n`;
}
