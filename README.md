# Hono + Bun API template

A starting point for APIs built with Hono and Bun. Includes PostgreSQL with Drizzle, Redis, BullMQ workers, S3-compatible storage, SMTP email, Better Auth, OpenAPI docs, and optional observability integrations.

## Getting started

Requirements: [Bun](https://bun.sh/) and Docker Compose.

1. Install dependencies:

   ```sh
   bun install
   ```

2. Start the local services:

   ```sh
   docker compose up -d
   ```

3. Set the required environment variables before starting the app: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `REDIS_URL`, `REDIS_JOBS_URL`, `S3_BUCKET`, `EMAIL_FROM`, and `SMTP_URL`. See `src/core/env.ts` for all supported settings. The Compose file provides local PostgreSQL, Redis, Redis for jobs, RustFS, and Mailpit.

   Generate the auth secret with `bunx auth@latest secret`, and set `BETTER_AUTH_URL` to the API's public origin, e.g. `http://localhost:3000`.

4. Start the API and worker (in separate terminals):

   ```sh
   bun run dev
   bun run worker
   ```

## Auth

Better Auth handles email/password and optional Google sign-in under `/api/auth/*`. The Drizzle tables live in `src/db/schema/auth.ts`, and the auth tables are exported from `src/db/schema`.

- Email/password is enabled by default.
- Google is enabled only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Register `${BETTER_AUTH_URL}/api/auth/callback/google` as the callback URL.
- `BETTER_AUTH_TRUSTED_ORIGINS` is a comma-separated list of browser origins allowed to make credentialed requests. The `BETTER_AUTH_URL` origin is trusted automatically.
- `AUTH_REQUIRE_EMAIL_VERIFICATION` defaults to `false`; verification emails are still sent on sign-up.
- `AUTH_TRUST_PROXY_HEADERS` trusts `X-Forwarded-Proto` and `X-Forwarded-Host` for auth, and `X-Forwarded-For` for the global rate limiter's client IP key. Enable it only when a trusted reverse proxy overwrites those headers; otherwise clients could spoof their rate-limit key. It does not configure Better Auth's own IP-based rate limiter.

`BETTER_AUTH_TRUSTED_ORIGINS` controls Better Auth's own origin check, not browser CORS. If a browser frontend runs on a different origin, add Hono's `cors` middleware with `credentials: true` and the same explicit origins.

The auth tables are defined, but migrations are intentionally left to the normal Drizzle workflow:

```sh
bun run db:generate
bun run db:migrate
```

If you add Better Auth plugins, regenerate the schema with `bun run auth:generate`.

Routes can resolve a session with `optionalSession` or require one with `requireSession`. `GET /me` is a protected example that returns only the user:

```ts
import { getSessionUser, requireSession } from "./auth/middleware";

app.get("/me", requireSession, (c) => c.json(getSessionUser(c)));
```

Browser clients must send credentials with auth requests (`credentials: "include"` in fetch). Server-side clients should forward the incoming `Cookie` header.

## Documentation

When `DOCS_ENABLED=true`, the app serves:

- `/docs` — Scalar reference for the merged app and Better Auth API.
- `/openapi.json` — generated app specification with Better Auth's `/api/auth/*` paths merged in.
- `/llms.txt` — Markdown generated from the merged `openapi.json` with `@scalar/openapi-to-markdown`, intended for LLM tools.
- `/api/auth/open-api/generate-schema` — Better Auth's raw OpenAPI schema.

## Useful commands

```sh
bun run auth:generate     # Regenerate the Better Auth Drizzle schema
bun run openapi:generate  # Regenerate openapi.json
bun run db:generate       # Generate a database migration
bun run db:migrate        # Apply migrations
bun run db:seed           # Seed the database
bun run test:unit         # Run unit tests
bun run lint              # Lint the project
```

View BullMQ queues using the local jobs Redis:

```sh
bunx @bull-board/cli -r redis://:redis@localhost:6381/0 -p 4000
```

Run or generate the Fern documentation:

```sh
bunx fern docs dev
# or
bunx fern generate docs
```
