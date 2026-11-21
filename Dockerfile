# syntax=docker/dockerfile:1
# One image, three processes (pick with the command):
#   API (default)   bun run src/main.ts
#   Worker          bun run src/worker.ts      (disable the HTTP healthcheck)
#   Migrations      bun run src/migrate.ts     (release step, exits when done)
ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION}-slim AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000

COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src

USER bun
EXPOSE 3000

# On SIGTERM the API answers 503 on /readyz for HTTP_SHUTDOWN_GRACE_MS, then
# drains in-flight requests; give the container at least that long to stop.
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "run", "src/main.ts"]
