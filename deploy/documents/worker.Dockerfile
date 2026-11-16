ARG BUN_IMAGE=oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
FROM ${BUN_IMAGE} AS bun
FROM ${NODE_IMAGE} AS dependencies
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/engines
COPY deploy/documents/toolchain/package.json deploy/documents/toolchain/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM dependencies AS build
WORKDIR /source
COPY src/shared/builds ./src/shared/builds
COPY src/shared/plugins ./src/shared/plugins
COPY src/shared/packages ./src/shared/packages
COPY src/shared/sites ./src/shared/sites
COPY src/shared/presentation/template-snapshot.ts ./src/shared/presentation/template-snapshot.ts
COPY src/shared/presentation/theme-profile.ts ./src/shared/presentation/theme-profile.ts
COPY src/document-worker ./src/document-worker
RUN bun build src/document-worker/main.ts --target=node --outfile=/opt/panda/worker.js

FROM ${NODE_IMAGE} AS runtime
COPY --from=dependencies /opt/engines /opt/engines
COPY --from=build /opt/panda /opt/panda
LABEL ai.hiforce.panda.build-protocol="1" \
      ai.hiforce.panda.theme-protocol="1" \
      ai.hiforce.panda.trusted-theme-protocol="1" \
      ai.hiforce.panda.profile-theme-protocol="1" \
      ai.hiforce.panda.site-project-protocol="1" \
      ai.hiforce.panda.resource-build-protocol="2" \
      ai.hiforce.panda.hexo-stylus-protocol="1" \
      ai.hiforce.panda.engine.hexo="8.1.1" \
      ai.hiforce.panda.engine.docusaurus="3.10.2"
ENV DOCUSAURUS_TELEMETRY_DISABLED=true NODE_ENV=production HOME=/tmp
USER 1000:1000
WORKDIR /work
ENTRYPOINT ["node", "/opt/panda/worker.js"]
