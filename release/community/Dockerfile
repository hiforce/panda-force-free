# syntax=docker/dockerfile:1
ARG BUILD_BASE=hiforceai/panda-force-build-base:deps-7fc21178477adfc2@sha256:d1b3e34b9afe1405a52181f54b233e2ad1eedc7eb45babfd58548afbdaf6adf5
ARG RUNTIME_BASE=hiforceai/panda-force-runtime-base:deps-7fc21178477adfc2@sha256:7d5b745416b1321c73ebd6cf1b08535d3757de8ddb63c7bdf67a6312265c32c8
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
RUN if [ "$INSTALL_VIDEO_TOOLS" = "1" ]; then \
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
COPY src ./src
COPY scripts/start.ts ./scripts/start.ts
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY LICENSES ./LICENSES
RUN find /app/src /app/public /app/scripts /app/LICENSES \( ! -perm -a=r -o \( -type d ! -perm -a=x \) -o \( -perm /111 ! -perm -a=x \) \) -exec chmod a+rX {} + \
    && mkdir -p /usr/local/lib/panda \
    && bun build src/cli/main.ts --target=node --outfile=/usr/local/lib/panda/panda.mjs \
    && chmod 0755 /usr/local/lib/panda/panda.mjs \
    && ln -s /usr/local/lib/panda/panda.mjs /usr/local/bin/panda
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
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
