ARG BUN_IMAGE=oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
FROM ${BUN_IMAGE} AS build
WORKDIR /source
COPY src/shared/builds ./src/shared/builds
COPY src/shared/plugins ./src/shared/plugins
COPY src/shared/packages ./src/shared/packages
COPY src/shared/sites ./src/shared/sites
COPY src/shared/presentation/template-snapshot.ts ./src/shared/presentation/template-snapshot.ts
COPY src/shared/presentation/theme-profile.ts ./src/shared/presentation/theme-profile.ts
COPY src/shared/diagnostics.js src/shared/errors.js src/shared/utf8.ts ./src/shared/
COPY src/server/logging/rotating-file.js ./src/server/logging/rotating-file.js
COPY src/executor ./src/executor
RUN bun build src/executor/main.ts --target=bun --outfile=/app/executor.js

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
COPY --from=build /app/executor.js /app/executor.js
ENV PANDA_FORCE_EXECUTOR_HOME=/var/lib/panda-executor PANDA_FORCE_EXECUTOR_TOKEN_FILE=/run/panda-executor/token PORT=8900
EXPOSE 8900
ENTRYPOINT ["bun", "/app/executor.js"]
