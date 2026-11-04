FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    BUN_INSTALL_BIN=/usr/local/bin \
    NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates bubblewrap build-essential git \
        openssh-client python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@0.166.0

WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile \
    && npm rebuild node-pty --build-from-source \
    && node -e "require('node-pty')"

COPY . .
RUN bun run build:client \
    && mkdir -p /home/codex/.codex /home/codex/workspace /var/lib/panda-force \
    && chmod 700 /var/lib/panda-force \
    && chown -R 1000:1000 /home/codex /var/lib/panda-force

ENV HOME=/home/codex \
    CODEX_HOME=/home/codex/.codex \
    PANDA_FORCE_HOME=/var/lib/panda-force \
    PANDA_FORCE_CWD=/home/codex/workspace \
    PANDA_FORCE_APP_SERVER_MODE=isolated \
    HOST=0.0.0.0 \
    PORT=8899
USER 1000:1000

EXPOSE 8899
CMD ["bun", "run", "start"]
