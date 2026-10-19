---
name: Customize Hono Template
description: Customize this Hono/Bun starter for a product. Use when naming or branding the app, changing its database or runtime, or preparing it for deployment.
---

# Customize this template

Ask for missing choices before editing. Batch questions into one short checklist:

- Product name, package slug, public domain/docs organization, sender and support emails, and desired email voice.
- Keep PostgreSQL, or switch to MySQL, SQLite, Turso, or another database? Confirm the target and whether existing schema/data must be preserved.
- Keep Bun, use pure Node.js, or another runtime? Confirm the deployment target/runtime version if known.
- Is deployment serverless? If so, which platform, and will the queue worker run separately?
- Keep, rename, or remove the sample job?

Do not guess answers or perform broad search-and-replace. Summarize consequential architecture changes before applying them. If a requested database/runtime/platform is not compatible with the current design, explain why and propose the smallest appropriate change; do not silently claim support. Preserve secrets and local development defaults unless asked to change them.

## Customize

Inspect the repository for additional project-specific placeholders, then review these known locations:

- `fern/docs.yml`, `fern/fern.config.json`: docs hostname and Fern organization.
- `package.json`, `bun.lock`: package name; update the lockfile with Bun, never by editing dependency records manually.
- `README.md`: product name and project description.
- `.env.example`: sender/reply-to addresses and sample values; never put real secrets here.
- `docker-compose.yml`, `docker-compose.test.yml`: `hono-app-` container names; use the agreed project prefix or remove fixed container names if appropriate.
- `src/integrations/email/registry.ts`: `Acme` subject.
- `src/integrations/email/templates/welcome.tsx`, `password-reset.tsx`: product-specific email wording.
- `src/jobs/index.ts`: example job schema, name, and sample log/error text. Keep the reusable queue/email code.

## Database, runtime, and deployment

Treat these as design changes, not placeholder replacements. The current database layer uses Drizzle with `pg`/node-postgres in `src/core/db.ts`; changing databases may require a Drizzle driver, schema/type, migration, environment, and test updates. Verify the selected database's supported features before changing them.

The current app starts through Bun (`src/index.ts`), uses Bun-specific integrations/APIs, and has a separate long-running BullMQ worker (`src/worker.ts`). For Node or serverless, check the actual target's Hono adapter, runtime APIs, database connection strategy, and worker/queue model before editing. Serverless API deployment does not make the worker serverless-compatible; keep it as a separate process or propose a suitable alternative explicitly.

## Verify

After edits, search again for old placeholder values, inspect the diff, and run relevant checks (at minimum formatting/typecheck when applicable). Regenerate OpenAPI or run tests only if the changes affect them. Report choices made, files changed, checks run, and any unresolved platform constraints.
