# Hono + Bun API template

A starting point for APIs built with Hono and Bun. Includes PostgreSQL with Drizzle, Redis, BullMQ workers, S3-compatible storage, SMTP email, OpenAPI docs, and optional observability integrations.

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

3. Set the required environment variables before starting the app: `DATABASE_URL`, `REDIS_URL`, `REDIS_JOBS_URL`, `S3_BUCKET`, `EMAIL_FROM`, and `SMTP_URL`. See `src/core/env.ts` for all supported settings. The Compose file provides local PostgreSQL, Redis, Redis for jobs, RustFS, and Mailpit.

4. Start the API and worker (in separate terminals):

   ```sh
   bun run dev
   bun run worker
   ```

## Useful commands

```sh
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
