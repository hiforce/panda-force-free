# syntax=docker/dockerfile:1
ARG BUILD_BASE=hiforceai/panda-force-build-base@sha256:66696cf2668c2b2e017d9f106533bdd016ac2a5d5a4c0f593ee59e8f36b75e5e
ARG RUNTIME_BASE=hiforceai/panda-force-runtime-base@sha256:d55e7cb61e32fe11750903d32a3d16bd0433be6881e84254772f30312cd4b9c5
FROM ${BUILD_BASE} AS build
USER root
WORKDIR /app
COPY scripts/build/dependencies.mjs /opt/panda-force-dependencies.mjs
RUN node /opt/panda-force-dependencies.mjs capture /app /tmp/panda-force-base-dependencies.json /opt/panda-force-dependencies.sha256 \
    && rm -rf patches
COPY package.json bun.lock ./
COPY patches ./patches
RUN node /opt/panda-force-dependencies.mjs verify /app /tmp/panda-force-base-dependencies.json \
    && rm /tmp/panda-force-base-dependencies.json
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY tests ./tests
COPY release/community ./release/community
COPY LICENSES ./LICENSES
COPY deploy/documents ./deploy/documents
COPY deploy/previews ./deploy/previews
COPY deploy/search ./deploy/search
COPY docker-compose*.yml ./
COPY tsconfig*.json eslint.config.mjs prettier.config.mjs Dockerfile .dockerignore LICENSE THIRD_PARTY_NOTICES.md ./
ARG VERIFICATION_PROFILE=none
ARG BUILD_BASE
ARG RUNTIME_BASE
RUN PANDA_FORCE_BUILD_BASE=${BUILD_BASE} PANDA_FORCE_RUNTIME_BASE=${RUNTIME_BASE} PANDA_FORCE_VERIFICATION_PROFILE=${VERIFICATION_PROFILE} bun scripts/build/application.ts
ARG PANDA_FORCE_CDN_BASE_URL
ARG PANDA_FORCE_CDN_BUCKET
ARG PANDA_FORCE_CDN_PREFIX=pandaforce/static
ARG PANDA_FORCE_CDN_S3_ENDPOINT
ARG AWS_REGION
RUN --mount=type=secret,id=cdn_credentials \
    if [ -n "$PANDA_FORCE_CDN_BASE_URL" ]; then \
      test -s /run/secrets/cdn_credentials && \
      set -a && . /run/secrets/cdn_credentials && set +a && \
      bun run build:client && cp -a dist/cdn-public/. public/; \
    fi

FROM ${RUNTIME_BASE} AS runtime
USER root
WORKDIR /app
ARG INSTALL_VIDEO_TOOLS=1
RUN if [ "$INSTALL_VIDEO_TOOLS" = "1" ] && ! (command -v ffmpeg > /dev/null && command -v ffprobe > /dev/null \
      && command -v fc-match > /dev/null && fc-match 'Noto Sans CJK SC' --format '%{family}\n' | grep -qi 'Noto Sans CJK SC'); then \
      command -v apt-get > /dev/null || { echo 'Selected runtime base lacks required video tools or Noto CJK fonts; rebuild the matching creative base.' >&2; exit 1; }; \
      apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-noto-cjk \
      && rm -rf /var/lib/apt/lists/*; \
    fi
COPY scripts/build/dependencies.mjs /opt/panda-force-dependencies.mjs
RUN node /opt/panda-force-dependencies.mjs capture /app /tmp/panda-force-base-dependencies.json /opt/panda-force-dependencies.sha256 \
    && rm -rf patches
COPY package.json bun.lock ./
COPY patches ./patches
RUN node /opt/panda-force-dependencies.mjs verify /app /tmp/panda-force-base-dependencies.json \
    && rm /tmp/panda-force-base-dependencies.json
COPY --from=build /app/public ./public
COPY --from=build /app/.build-info/ ./
RUN node -e 'const fs=require("node:fs"),c=require("node:crypto"),i=JSON.parse(fs.readFileSync("build-info.json"));if(i.bases.engineLockSha256&&c.createHash("sha256").update(fs.readFileSync("/opt/panda-harness/engines.json")).digest("hex")!==i.bases.engineLockSha256)throw Error("Runtime base Harness versions differ from the reviewed lock");'
RUN node -e 'const fs=require("node:fs"),p=require("node:child_process"),i=JSON.parse(fs.readFileSync("build-info.json"));if(i.bases.creativeToolchain&&p.execFileSync("node",["/usr/local/lib/panda-creative.mjs","digest"],{encoding:"utf8"}).trim()!==i.bases.creativeToolchain.inputsSha256)throw Error("Runtime creative toolchain differs from the reviewed build base");'
COPY src ./src
COPY scripts/start.ts ./scripts/start.ts
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY LICENSES ./LICENSES
RUN find /app/src /app/public /app/scripts /app/LICENSES \( ! -perm -a=r -o \( -type d ! -perm -a=x \) -o \( -perm /111 ! -perm -a=x \) \) -exec chmod a+rX {} + \
    && mkdir -p /usr/local/lib/panda \
    && bun build src/cli/main.ts --target=node --outfile=/usr/local/lib/panda/panda.mjs \
    && chmod 0755 /usr/local/lib/panda/panda.mjs \
    && ln -s /usr/local/lib/panda/panda.mjs /usr/local/bin/panda
RUN if ! getent passwd 1000 > /dev/null; then \
      getent group 1000 > /dev/null || /usr/sbin/groupadd --gid 1000 codex; \
      /usr/sbin/useradd --uid 1000 --gid 1000 --home-dir /home/codex --shell /bin/bash --no-create-home codex; \
    fi
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    PATH="${PATH}:/usr/local/sbin:/usr/sbin:/sbin" \
    NODE_ENV=production \
    HOME=/home/codex \
    CODEX_HOME=/home/codex/.codex \
    PANDA_FORCE_HOME=/var/lib/panda-force \
    XDG_CACHE_HOME=/var/lib/panda-force/cache \
    PANDA_FORCE_DEFAULT_CWD=/home/codex/workspace \
    PANDA_FORCE_DEFAULT_APP_SERVER_MODE=isolated \
    HOST=0.0.0.0 \
    PORT=8899
USER 1000:1000
EXPOSE 8899
CMD ["bun", "run", "start"]
