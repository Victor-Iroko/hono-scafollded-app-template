`rate-limit.ts`

- Unknown for rate limit (they get pooled together)
- Custom header for generator key instead of relying on x-forwarded-for
- Only counting timeouts as failures for the circuit braker guard for rate-limiting
- the assumption of 1 request = 1 point in the response headers calculation

`db-errors.ts`

- field-specific `fields` for `23505`: constraint names cannot be parsed — a composite key like `users_org_id_email_key` reads exactly like a single-column unique on `email` — so a duplicate email currently returns a generic 409 with no `fields` entry. A declarative `Record<constraintName, fieldPath>` consulted in `describeDbError()` gives signup forms the field back without guessing, and any unlisted constraint keeps falling back to the generic message. Needs seed entries as unique constraints land in `src/db/schema`

`email` — delivery tracking (deferred from the first pass)

- `src/db/schema/email.ts`: `emails` (id, to, from, template, data, idempotencyKey, status, messageId, attempts, lastError, timestamps) and `email_suppressions` (email, reason, detail, createdAt), enums plus migration
- persist before enqueue: insert the row `queued`, then enqueue `{ emailId }` with jobId = row id so a double enqueue collapses; mark `failed` if the enqueue throws (transactional outbox is the upgrade path)
- worker loads the row instead of trusting the payload, checks suppression first, writes back `sent` + `messageId` or `failed` + `lastError`
- synchronous hard bounce: nodemailer surfaces `responseCode`, so a 5xx marks the row `bounced` and suppresses the address without rethrowing; a 4xx stays retryable
- `handleEmailEvent()` for normalized `delivered | bounced | complained | delivery_delayed`: update status monotonically (never downgrade) and suppress on hard bounce + complaint only; soft bounce and delivery_delayed must not suppress
- provider adapter (signature verify + parse into the normalized event) stays a slot until a provider is picked — Postmark/Mailgun/SES-over-SNS all pair with SMTP, so the transport does not change
- when the adapter lands: `c.req.text()` for the raw body before any JSON parse, timestamp window against replays, dedupe by event id, 2xx fast and queue the work, mount outside the global rate limiter, and gate it on `EMAIL_WEBHOOK_SECRET`
- SMTP sends no webhooks at all; the async cases (later bounces, spam complaints, open/click) need a VERP bounce mailbox if no provider is ever added
