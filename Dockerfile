FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS toolchain
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates build-essential python3 git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@0.166.0
WORKDIR /app

FROM toolchain AS build
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql \
    && rm -rf /var/lib/apt/lists/* \
    && bun node_modules/playwright/cli.js install --with-deps chromium webkit
RUN apt-get update \
    && apt-get install -y --no-install-recommends vim \
    && rm -rf /var/lib/apt/lists/* \
    && npm rebuild node-pty --build-from-source \
    && vim --version > /dev/null
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY tests ./tests
COPY release/community ./release/community
COPY LICENSES ./LICENSES
COPY tsconfig*.json eslint.config.mjs prettier.config.mjs Dockerfile .dockerignore LICENSE THIRD_PARTY_NOTICES.md ./
RUN bun run release:proof

FROM toolchain AS production-dependencies
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production --omit=peer \
    && npm rebuild node-pty --build-from-source \
    && node -e "require('node-pty'); for (const name of ['jsdom', 'typescript', 'eslint', 'prettier', 'playwright']) { let found = false; try { require.resolve(name); found = true; } catch {} if (found) throw new Error('Development dependency in runtime: ' + name); }"

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runtime
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=toolchain /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates bubblewrap git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/local/lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY --from=build /app/.build-proof/verification.json ./verification.json
COPY src ./src
COPY scripts/start.ts ./scripts/start.ts
COPY package.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY LICENSES ./LICENSES
RUN mkdir -p /home/codex/.codex /home/codex/workspace /var/lib/panda-force \
    && chmod 700 /var/lib/panda-force \
    && chown -R 1000:1000 /home/codex /var/lib/panda-force
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    NODE_ENV=production \
    HOME=/home/codex \
    CODEX_HOME=/home/codex/.codex \
    PANDA_FORCE_HOME=/var/lib/panda-force \
    PANDA_FORCE_DEFAULT_CWD=/home/codex/workspace \
    PANDA_FORCE_DEFAULT_APP_SERVER_MODE=isolated \
    HOST=0.0.0.0 \
    PORT=8899
USER 1000:1000
EXPOSE 8899
CMD ["bun", "run", "start"]
