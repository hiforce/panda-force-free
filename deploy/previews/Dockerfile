ARG BUN_IMAGE=oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
FROM ${BUN_IMAGE} AS bun
FROM ${NODE_IMAGE} AS runtime
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY deploy/previews/package.json deploy/previews/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/browsers bun node_modules/playwright/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.cache \
    && chmod -R a+rX /opt/browsers
COPY src/preview-renderer ./src/preview-renderer
COPY src/shared/template-previews ./src/shared/template-previews
COPY src/shared/i18n/locale-policy.js ./src/shared/i18n/locale-policy.js
RUN bun build src/preview-renderer/main.ts --target=node --external=playwright --outfile=/app/renderer.js
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers HOME=/tmp NODE_ENV=production PORT=8901
USER 1000:1000
EXPOSE 8901
ENTRYPOINT ["node", "/app/renderer.js"]
