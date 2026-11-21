# Database, email and telemetry on functions

## Postgres

Each function instance holds its own pool, and instances multiply under load,
so connections must go through a transaction-mode pooler and stay at one per
instance.

- **Drizzle (`src/platform/database.ts`):** `DB_POOL_MAX=1`, a short
  `DB_IDLE_TIMEOUT_MS` (e.g. 5000), and `prepare: false` on `PgClient.layer`
  (transaction poolers cannot keep named prepared statements). Use the
  provider's pooled URL (Neon `-pooler` host, Supabase port 6543, RDS Proxy).
- **Better Auth (`src/auth/auth.ts`):** `AUTH_DB_POOL_MAX=1` on the same pooled URL.
- **Migrations:** use the direct (non-pooled) URL in the deploy step.

## Email

SMTP works on Node functions but opens a connection per cold instance. For an
HTTP provider, rewrite only the inside of `Mailer.layer`
(`src/platform/mailer.ts`): keep the `send(email)` / `check` interface and
`MailerError({ permanent })`, send with `HttpClient`, and mark 4xx validation
rejections (bad address, suppressed recipient) as `permanent: true`, 429 and 5xx
as `permanent: false`. Callers and the job handler do not change.

## Telemetry

- **OTLP:** exporters batch on intervals; the platform may freeze the instance
  before they fire. Flush `OtlpExporter.Flusher` after each request (see
  `01-entrypoint.md`). Set `OTEL_EXPORTER_OTLP_ENDPOINT` to a hosted collector
  or vendor endpoint; the local `collector.yml` fan-out can run as a hosted
  collector too.
- **Sentry:** `@sentry/effect` builds on `@sentry/node`, which runs on Node
  functions. Call `Sentry.flush(2000)` after each request. `reportError` and the
  trace linking work unchanged.
- **Logs:** console JSON goes to the platform's log drain.
