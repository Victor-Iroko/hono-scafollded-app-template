# Effect for beginners: everything you need to read this repo

This guide explains every Effect v4 idea this codebase uses, from scratch, with
examples taken from the repo itself. Read it top to bottom once; afterwards use
the [glossary](#20-glossary) and the [file tour](#18-a-request-end-to-end) as a
reference.

You need to know TypeScript and `async`/`await`. You do not need to know
functional programming.

Contents:

1. [Why Effect exists](#1-why-effect-exists)
2. [The `Effect` type](#2-the-effect-type)
3. [Effects are lazy: describing vs running](#3-effects-are-lazy-describing-vs-running)
4. [`Effect.gen` and `yield*`: async/await for Effect](#4-effectgen-and-yield-asyncawait-for-effect)
5. [`pipe`: chaining transformations](#5-pipe-chaining-transformations)
6. [Errors: expected failures vs defects](#6-errors-expected-failures-vs-defects)
7. [`Exit`, `Cause` and `Option`](#7-exit-cause-and-option)
8. [Services: dependencies in the type](#8-services-dependencies-in-the-type)
9. [Layers: how services are built and wired](#9-layers-how-services-are-built-and-wired)
10. [Resources, scopes and shutdown](#10-resources-scopes-and-shutdown)
11. [Config](#11-config)
12. [Schema: validation and types from one definition](#12-schema-validation-and-types-from-one-definition)
13. [Observability: `Effect.fn`, spans, logs, metrics](#13-observability-effectfn-spans-logs-metrics)
14. [Concurrency: fibers, `Effect.all`, timeouts, retries, schedules](#14-concurrency-fibers-effectall-timeouts-retries-schedules)
15. [The HTTP layer: `HttpApi` and middleware](#15-the-http-layer-httpapi-and-middleware)
16. [Persistence: Redis, rate limiting, circuit breaker, queues](#16-persistence-redis-rate-limiting-circuit-breaker-queues)
17. [Bridging Promises and callbacks](#17-bridging-promises-and-callbacks)
18. [A request, end to end](#18-a-request-end-to-end)
19. [Testing with Effect](#19-testing-with-effect)
20. [Glossary](#20-glossary)
21. [Common mistakes](#21-common-mistakes)
22. [Where to learn more](#22-where-to-learn-more)

---

## 1. Why Effect exists

A normal `async function` hides three important facts in its signature:

```ts
async function getProfile(userId: string): Promise<Profile>;
```

- **What can go wrong?** The `Promise` can reject with _anything_. TypeScript
  does not tell you that it might fail with "not found", or with a database
  error.
- **What does it need?** It secretly reaches for a database connection,
  usually through a global or an import. You cannot see that from the
  signature, and tests have to patch modules to replace it.
- **When does it run?** As soon as you call it. You cannot build it now and
  decide later whether to run it, retry it, or time it out.

Effect fixes all three by making a program a **value** whose type lists its
success, its errors and its requirements:

```ts
getProfile: (userId: string) => Effect.Effect<Profile, NotFound, Database>;
//                                            success  error     needs
```

Everything else in this guide (services, layers, typed errors, retries,
resource safety, tracing) builds on that one idea.

---

## 2. The `Effect` type

```ts
Effect.Effect<A, E, R>;
```

| Parameter | Meaning                                | Example in this repo               |
| --------- | -------------------------------------- | ---------------------------------- |
| `A`       | the value it produces on success       | `Profile`                          |
| `E`       | the _expected_ errors it can fail with | `NotFound`, `MailerError`          |
| `R`       | the services it needs to run           | `Database`, `Mailer`, `RateLimits` |

`E = never` means "cannot fail with an expected error". `R = never` means "needs
nothing; ready to run".

Creating simple effects:

```ts
Effect.succeed(42)                    // Effect<number, never, never>
Effect.fail(new NotFound({ ... }))    // Effect<never, NotFound, never>
Effect.sync(() => Date.now())         // run a synchronous side effect lazily
Effect.void                           // succeeds with undefined
```

Think of an `Effect` as a **recipe**, not a result. A `Promise` is a cake that
is already in the oven; an `Effect` is the recipe card for the cake.

---

## 3. Effects are lazy: describing vs running

Nothing happens when you create an effect. It runs only when handed to a
**runtime**:

```ts
const program = Effect.log("hello"); // nothing printed yet
await Effect.runPromise(program); // now it prints
```

Ways to run an effect in this repo:

| Where                          | How it runs                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `src/main.ts`, `src/worker.ts` | `runLongLived(...)` → `BunRuntime.runMain` (handles SIGTERM, exit codes)          |
| `src/migrate.ts`               | `BunRuntime.runMain`                                                              |
| Tests                          | `Effect.runPromise(...)` or a `ManagedRuntime`                                    |
| Inside Better Auth callbacks   | `Effect.runPromiseWith(context)` (see [§17](#17-bridging-promises-and-callbacks)) |

Because effects are values, you can pass them around, store them, and wrap
them. For example, `src/api/health/health.service.ts` builds the readiness
probes once and wraps them with `Effect.cachedWithTTL`, getting back a _new_
effect that only re-runs the probes every 2 seconds. That is only possible
because the probe is a description, not something already running.

---

## 4. `Effect.gen` and `yield*`: async/await for Effect

`Effect.gen` lets you write effects in a sequential style, exactly like
`async`/`await`:

| async/await            | Effect                                                      |
| ---------------------- | ----------------------------------------------------------- |
| `async function () {}` | `Effect.gen(function* () {})`                               |
| `await promise`        | `yield* effect`                                             |
| `throw error`          | `return yield* Effect.fail(error)` or `return yield* error` |
| `return value`         | `return value`                                              |

From `src/api/account/account.service.ts`:

```ts
const getProfile = Effect.fn("AccountService.getProfile")(function* (userId: string) {
  const [profile] = yield* db.select({ ... }).from(user).where(eq(user.id, userId));
  if (!profile) return yield* new NotFound({ detail: "Account not found" });
  return profile;
});
```

Read it line by line:

- `yield* db.select(...)` runs the query and gives you the rows (like `await`).
- `return yield* new NotFound(...)`: errors created with `Schema.TaggedError`
  or `HttpApiError.Problem` are themselves effects that fail, so you can
  `yield*` them directly. `return` is there so TypeScript knows the function
  stops.
- The final `return profile` is the success value.

`yield*` also **reads services**: `const db = yield* Database;` gets the
`Database` service from the environment (see [§8](#8-services-dependencies-in-the-type)).

> The star matters. `yield effect` (no star) does not run the effect. Always
> write `yield*`.

---

## 5. `pipe`: chaining transformations

Every effect has a `.pipe(...)` method. It passes the effect through a list of
functions, left to right:

```ts
db.execute(sql`select 1`).pipe(
  Effect.timeout(Duration.seconds(2)), // fail if it takes longer than 2s
  Effect.exit, // turn success/failure into a value
);
```

is the same as `Effect.exit(Effect.timeout(db.execute(...), Duration.seconds(2)))`,
just readable. Most Effect functions come in a "pipeable" form for this:
`Effect.map`, `Effect.flatMap`, `Effect.tap`, `Effect.withSpan`,
`Effect.annotateLogs`, `Layer.provide`, ...

The most common ones:

| Function             | What it does                                                                         |
| -------------------- | ------------------------------------------------------------------------------------ |
| `Effect.map(f)`      | transform the success value                                                          |
| `Effect.flatMap(f)`  | run another effect that depends on the success value                                 |
| `Effect.tap(f)`      | run a side effect with the value, keep the original value                            |
| `Effect.andThen(e)`  | run `e` after this one                                                               |
| `Effect.asVoid`      | throw away the success value                                                         |
| `Effect.mapError(f)` | transform the error                                                                  |
| `Effect.orDie`       | turn expected errors into defects (see [§6](#6-errors-expected-failures-vs-defects)) |

---

## 6. Errors: expected failures vs defects

Effect distinguishes two kinds of failure:

- **Failures (expected errors)** are part of the type (`E`). They are things
  callers should handle: "account not found", "SMTP rejected the message".
- **Defects (unexpected errors)** are bugs or "this should never happen"
  situations: a thrown exception, a broken invariant. They are _not_ in the
  type. They travel up until something at the edge catches them (here, the
  HTTP middleware turns them into a 500 and reports them to Sentry).

### Defining errors

With `Schema.TaggedError` (from `src/platform/mailer.ts`):

```ts
export class MailerError extends Schema.TaggedError<MailerError>()("MailerError", {
  permanent: Schema.Boolean,
  cause: Schema.Defect(),
}) {}
```

- `"MailerError"` becomes the error's `_tag` field. Effect uses `_tag` to tell
  errors apart.
- The fields are validated with Schema and become properties:
  `new MailerError({ permanent: true, cause })`.

HTTP errors use `HttpApiError.Problem` instead (`src/http/errors.ts`), which is
the same idea plus an HTTP status and an RFC 9457 JSON body:

```ts
export class NotFound extends HttpApiError.Problem<NotFound>()("NotFound", {
  type: "about:blank",
  status: 404,
  title: "Not Found",
}) {}
```

### Handling errors

```ts
// Recover from one specific error by its _tag (src/jobs/email.job.ts)
mailer.send(email).pipe(
  Effect.catchTag("MailerError", (error) =>
    error.permanent ? dropIt(error) : Effect.fail(error),
  ),
)

// "I don't expect this to fail; if it does, it's a bug" → defect
db.select(...).pipe(Effect.orDie)

// Convert to another error type
Effect.mapError((cause) => new EmailEnqueueError({ cause }))
```

After `catchTag("MailerError", ...)`, TypeScript removes `MailerError` from the
error type (unless your handler re-fails with it). The types always show what is
still unhandled.

### Why `Effect.orDie` on database queries?

In `AccountService.getProfile` a database failure is not something the caller
can do anything about, so it becomes a defect. The global middleware still
answers correctly: `renderFailures` in `src/http/middleware.ts` inspects the
defect and maps Postgres errors by SQLSTATE (unique violation → 409, and so
on, in `src/platform/database.error.ts`).

---

## 7. `Exit`, `Cause` and `Option`

Three small data types appear everywhere.

### `Option`

"A value or nothing", instead of `undefined`:

```ts
Option.some(5)   Option.none()
Option.isSome(o) Option.getOrElse(o, () => "unknown")
```

In this repo, optional config values are `Option`s
(`Config.option(Config.String("GOOGLE_CLIENT_ID"))`), and
`request.remoteAddress` is an `Option<string>`.

### `Exit`

The result of running an effect, as a value: `Exit.Success` with the value, or
`Exit.Failure` with a `Cause`. `Effect.exit(effect)` turns an effect that might
fail into one that always succeeds with an `Exit`, which is handy when you want
to look at the outcome instead of propagating it:

```ts
const outcome = yield * probe.pipe(Effect.timeout(PROBE_TIMEOUT), Effect.exit);
const ok = outcome._tag === "Success";
```

### `Cause`

The full story of why an effect failed. A cause can hold expected failures,
defects, and interruptions (a fiber was cancelled, for example on shutdown or
when a client disconnects). Helpers used in this repo:

- `Cause.squash(cause)`: the single most relevant error.
- `Cause.hasInterruptsOnly(cause)`: it was just a cancellation, not an error
  (the middleware and job runner treat these differently, so a shutdown is not
  reported as a crash).
- `Cause.fail(error)`: build a cause from an error (for reporting).

---

## 8. Services: dependencies in the type

A **service** is an interface plus a unique key. Code asks for a service with
`yield*`, and the `R` type parameter records that it needs it.

Defining one (`src/platform/mailer.ts`, simplified):

```ts
export class Mailer extends Context.Service<
  Mailer,                                   // the class itself (self type)
  {                                         // the interface
    readonly send: (email: OutboundEmail) => Effect.Effect<{ messageId: string }, MailerError>;
    readonly check: Effect.Effect<void, MailerError>;
  }
>()("app/Mailer") {                         // the unique key (runtime identity)
  static readonly layer = /* how to build it, see §9 */;
}
```

Using it:

```ts
const program = Effect.gen(function* () {
  const mailer = yield* Mailer; // program now has R = Mailer
  yield* mailer.send({ to: "a@b.c", subject: "Hi", html: "...", text: "..." });
});
```

`program` cannot be run until something **provides** a `Mailer`. TypeScript
enforces that: `Effect.runPromise(program)` is a compile error while `R` is not
`never`. That is how this repo guarantees nothing runs without its
dependencies, and how tests swap in fakes: provide a different implementation
of the same service.

`Mailer.of({ ... })` builds a value of the service's interface (it just
type-checks the object). `Mailer["Service"]` is the interface type.

### `Context.Reference`

A service with a **default value**, so nothing has to provide it. Used for the
per-endpoint rate-limit policy (`src/http/rate-limit.ts`):

```ts
export const RateLimitPolicy = Context.Reference<RateLimitOverride>("app/http/RateLimitPolicy", {
  defaultValue: () => ({}),
});
```

Effect itself uses references for things like the current log level
(`References.MinimumLogLevel`) and the current loggers.

---

## 9. Layers: how services are built and wired

A **layer** is a recipe for building services. Its type is:

```ts
Layer.Layer<ROut, E, RIn>;
//          builds  can fail with  needs
```

### Building a layer

`Layer.effect(Tag, effect)` builds a service by running an effect. From
`src/api/account/account.service.ts`:

```ts
static readonly layer = Layer.effect(
  AccountService,
  Effect.gen(function* () {
    const db = yield* Database;            // this layer needs Database
    const getProfile = Effect.fn("AccountService.getProfile")(function* (userId: string) { ... });
    return AccountService.of({ getProfile });
  }),
).pipe(Layer.provide(Database.layer));     // ...and provides it right here
```

Other constructors you will see:

| Constructor                   | Use                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Layer.succeed(Tag, value)`   | a ready-made value (tests use this for fakes)                                                                                     |
| `Layer.effect(Tag, effect)`   | build the service with an effect                                                                                                  |
| `Layer.effectDiscard(effect)` | run something at build time without producing a service (e.g. start workers, register a shutdown hook)                            |
| `Layer.unwrap(effect)`        | an effect that _returns a layer_: pick which layer to use based on config (`src/platform/observability.ts`, `src/http/server.ts`) |
| `Layer.mergeAll(a, b, c)`     | combine independent layers                                                                                                        |
| `Layer.empty`                 | a layer that does nothing                                                                                                         |

### Wiring layers together

- `Layer.provide(dep)`: satisfy this layer's needs with `dep`; the output only
  contains _this_ layer's services.
- `Layer.provideMerge(dep)`: same, but the output also includes `dep`'s
  services. Used when callers need both, e.g. the HttpApi middleware layers
  must be visible while routes are built (`src/http/server.ts`).

### The repo's one rule

> Every service's `static layer` already provides its own dependencies.

So `AccountService.layer` needs nothing. The entry points stay tiny:

```ts
// src/main.ts
runLongLived(Layer.launch(HttpServerLive.pipe(Layer.provide(ObservabilityLive))));
```

### "Won't `Database.layer` be built many times then?"

No. Layers are **memoized by reference** within one build: if ten layers all
`Layer.provide(Database.layer)`, the database pool is built once and shared.
(`Layer.fresh(layer)` would opt out; this repo never does.)

### `layer` vs `layerNoDeps`

Some services also expose `layerNoDeps`: the same layer _without_ its
dependencies provided. Tests use it to plug in fakes:

```ts
// src/http/rate-limit.ts
static readonly layerNoDeps = Layer.effect(RateLimit, /* needs RateLimits */);
static readonly layer = this.layerNoDeps.pipe(Layer.provide(RateLimits.layer));

// tests/unit/http/rate-limit.test.ts
RateLimit.layerNoDeps.pipe(Layer.provide(fakeRateLimits))
```

### `Layer.launch`

`Layer.launch(layer)` turns a layer into an effect that builds it and then
**runs forever** (until interrupted). It is how `main.ts` and `worker.ts` keep
the server and workers alive: the server is a layer, the workers are a layer.

---

## 10. Resources, scopes and shutdown

Anything that must be closed (connection pools, SMTP transports, Redis
clients, S3 clients) is opened with `Effect.acquireRelease`:

```ts
// src/platform/mailer.ts
const transport =
  yield *
  Effect.acquireRelease(
    Effect.sync(() => createTransport(url.toString())), // acquire
    (transport) => Effect.sync(() => transport.close()), // release
  );
```

The release function is registered on the current **scope**. A layer's scope
lives as long as the layer, so the release runs when the layer is torn down.

On SIGTERM:

1. `BunRuntime.runMain` interrupts the main fiber.
2. `Layer.launch` stops, and every layer's scope closes **in reverse order of
   construction**.
3. Each `acquireRelease` release runs: Redis closes, the pool ends, and so on.

The API uses that ordering on purpose (`src/http/server.ts`). `DrainBeforeStop`
is built _after_ the HTTP server, so its finalizer (added with
`Effect.addFinalizer`) runs _first_: it flips `/readyz` to 503, waits
`HTTP_SHUTDOWN_GRACE_MS`, and only then lets the server stop and drain requests.

`Effect.forkScoped` starts a background fiber tied to the current scope, so it
is interrupted automatically when the scope closes. The job workers
(`src/jobs/consume.ts`) and the Redis reconnect loop (`src/platform/redis.ts`)
use it.

`Effect.scoped` gives an effect its own scope that closes when the effect
finishes (used in tests).

---

## 11. Config

`src/config.ts` declares every environment variable with the `Config` module:

```ts
export const DatabaseConfig = Config.all({
  url: Config.Redacted("DATABASE_URL"),
  poolMax: intInRange("DB_POOL_MAX", { minimum: 1, maximum: 100 }, 10),
  ...
});
```

- A `Config` is another description: reading it (`yield* DatabaseConfig`) is
  an effect that can fail with a `ConfigError`. Services read their group while
  their layer builds, so bad config fails the boot before the port opens.
- `Config.withDefault(x)`, `Config.option(...)` (→ `Option`), `Config.Literals([...])`,
  `Config.Port`, `Config.URL`, `Config.Boolean`, `Config.Array(...)`,
  `Config.schema(schema, name)` for anything custom.
- `Config.Redacted` wraps secrets in a `Redacted` value: printing or logging it
  shows `<redacted>`. Get the real string only where needed with
  `Redacted.value(secret)`.
- By default config comes from `process.env`. Tests replace the source with
  `ConfigProvider.fromEnv({ env: {...} })` (`tests/support/config.ts`) instead
  of touching `process.env`.

---

## 12. Schema: validation and types from one definition

`effect/Schema` describes data once and gives you both a TypeScript type and a
runtime validator:

```ts
// src/api/account/account.schema.ts
export const Profile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  emailVerified: Schema.Boolean,
  image: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
});
export type Profile = typeof Profile.Type;
```

Two directions:

- **Decoding**: unknown input → typed value, or a `SchemaError`.
  `Schema.decodeUnknownEffect(Profile)(input)` returns an effect.
- **Encoding**: typed value → wire format (for example a `Date` → ISO string in
  JSON).

Where Schema is used in this repo:

| Use                          | Where                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| HTTP request/response bodies | `*.schema.ts`, declared on endpoints in `*.api.ts`; HttpApi decodes and encodes automatically |
| Error classes                | `Schema.TaggedError`, `HttpApiError.Problem`                                                  |
| Job payloads                 | `SendEmail` in `src/jobs/email.queue.ts`; validated when offered and when taken               |
| Email template data          | each template's `schema` in `src/integrations/email/templates.ts`                             |
| Paystack responses           | `src/integrations/paystack/paystack.schema.ts`                                                |
| Config with custom rules     | `intInRange` in `src/config.ts`                                                               |

Useful pieces: `Schema.Struct`, `Schema.String`, `Schema.Number`,
`Schema.Boolean`, `Schema.Literal("x")`, `Schema.Literals([...])`,
`Schema.Array(s)`, `Schema.Record(k, v)`, `Schema.NullOr(s)`,
`Schema.optionalKey(s)` (the key may be missing), `Schema.Unknown`,
`Schema.fromJsonString(s)` (parse JSON text then decode), and checks such as
`.check(Schema.isMinLength(32))`.

---

## 13. Observability: `Effect.fn`, spans, logs, metrics

### `Effect.fn`

Service methods are written with `Effect.fn("Name")(function* (...) { ... })`.
It is `Effect.gen` for functions, plus it wraps every call in a **tracing span**
named `Name`. That is why traces show `AccountService.getProfile`,
`Mailer.send`, `RateLimits.consume` without any extra code.

### Spans

A span is a timed step in a trace. Add one around any effect with
`Effect.withSpan("name", { attributes })`; add attributes to the current span
with `Effect.annotateCurrentSpan(...)`. `@effect/sql` records a span for every
SQL query, and the HTTP server one per request. Where they are exported is
configured in `src/platform/observability.ts` (OTLP, or Sentry when there is no
OTLP endpoint).

### Logs

```ts
yield *
  Effect.logInfo("email sent").pipe(
    Effect.annotateLogs({ template: job.template, messageId: sent.messageId }),
  );
```

- Levels: `logDebug`, `logInfo`, `logWarning`, `logError`. The minimum level
  comes from `LOG_LEVEL` (`References.MinimumLogLevel`).
- `Effect.annotateLogs({...})` adds structured fields to every log line emitted
  _inside_ the wrapped effect. The request-id middleware wraps the whole
  request, so every log line of that request carries `requestId`, `traceId`
  and `spanId`.
- `Logger.consoleJson` / `Logger.consolePretty()` decide the format.

### Metrics

```ts
const jobsProcessed = Metric.counter("jobs.processed", { incremental: true });
yield * Metric.update(Metric.withAttributes(jobsProcessed, { queue: name, outcome }), 1);
```

`Metric.counter` and `Metric.timer` (a duration histogram) are defined once at
module level; `Metric.update` records a value; `Metric.withAttributes` adds
labels. They are exported over OTLP every 10 seconds.

### Error reporting

`reportError(cause)` in `src/platform/observability.ts` sends a failure to
Sentry through Effect's `ErrorReporter`, tagged with the trace id and the
request or job id. The HTTP middleware calls it for 5xx responses, and the job
runner for jobs that fail their last attempt.

---

## 14. Concurrency: fibers, `Effect.all`, timeouts, retries, schedules

### Fibers

A **fiber** is a lightweight thread of execution managed by Effect (it is how
an effect runs). Thousands can run at once. You rarely create them by hand:

- `Effect.forkScoped(effect)` runs `effect` in the background, interrupted
  when the current scope closes (job workers, the circuit-breaker log listener).
- Interrupting a fiber is how Effect cancels work cleanly: finalizers still run.

### Running things concurrently

```ts
// src/api/health/health.service.ts
Effect.all(
  { database: checkDatabase, cacheRedis: checkCache, jobsRedis: checkJobs, storage: checkStorage },
  { concurrency: "unbounded" },
);
```

`Effect.all` runs a record or array of effects and collects the results. With
`concurrency: "unbounded"` they run at the same time; without it, one after
another.

### Timeouts

- `Effect.timeout(duration)`: fail with a timeout error if it takes too long
  (and interrupt the slow effect).
- `Effect.timeoutOrElse({ duration, orElse })`: run `orElse` instead, used for
  the per-request timeout that answers 503, and for SMTP/S3 calls that fail
  with a typed error.

Durations are values: `Duration.millis(100)`, `Duration.seconds(2)`.

### Retries and schedules

A `Schedule` describes _when_ to repeat or retry:

```ts
// Exponential backoff, capped at 5 seconds (src/platform/redis.ts)
Schedule.min([Schedule.exponential(Duration.millis(200)), Schedule.spaced(Duration.seconds(5))]);

// Paystack reads: jittered backoff, at most 3 retries, only network errors
Effect.retry({ schedule: READ_RETRY, times: 3, while: (error) => error.reason === "Network" });
```

`Effect.cachedWithTTL(effect, ttl)` memoizes a result for a while (readiness
probes), and `Effect.cached(effect)` memoizes it forever (the generated OpenAPI
document).

---

## 15. The HTTP layer: `HttpApi` and middleware

The HTTP API is **schema-first**: you declare the endpoints, then implement
them. One declaration drives routing, request decoding, response encoding, the
OpenAPI document and a typed client.

### Declaring endpoints (`<module>.api.ts`)

```ts
export class AccountApi extends HttpApiGroup.make("account")
  .add(HttpApiEndpoint.get("getMe", "/me", { success: Profile, error: NotFound }))
  .middleware(Authenticated) {}
```

- `HttpApiEndpoint.get(name, path, { success, error, payload, params, query })`.
- `HttpApiGroup.make(name)` groups endpoints; `.middleware(M)` applies
  middleware to the group.
- `src/http/api.ts` assembles all groups into one `HttpApi`. Order matters
  there: `.prefix("/v1")` and `.middleware(RateLimit)` apply to the groups
  added _before_ them, so health probes added afterwards stay unversioned and
  unlimited.

### Implementing them (`<module>.handlers.ts`)

```ts
export const AccountHandlersNoDeps = HttpApiBuilder.group(
  Api,
  "account",
  Effect.fn(function* (handlers) {
    const account = yield* AccountService;
    return handlers.handle("getMe", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        return yield* account.getProfile(user.id);
      }),
    );
  }),
);
```

`HttpApiBuilder.group` produces a **layer** for that group. TypeScript checks
that every endpoint is handled, that each handler returns the declared success
type, and that it can only fail with declared errors. Returning a `NotFound`
here becomes a 404 problem response automatically.

### Middleware

Two kinds:

1. **HttpApi middleware** (`HttpApiMiddleware.Service`) applies to groups or
   endpoints, can declare errors (documented in OpenAPI), and can **provide
   services** to handlers. `Authenticated` (`src/auth/auth.middleware.ts`)
   looks up the Better Auth session and provides `CurrentUser`, which is why
   the handler above can `yield* CurrentUser`. `RateLimit` is the other one.
2. **Router middleware** (`HttpRouter.middleware(fn, { global: true })`)
   wraps every request: `src/http/middleware.ts` builds the global pipeline
   (client address, request id, access log + metrics, security headers,
   failure rendering, body limit, timeout). Each piece is just a function from
   an HTTP effect to an HTTP effect.

### Plain routes

Routes outside the typed API use `HttpRouter.add(method, path, handler)`:
Better Auth's `/api/auth/*`, the docs routes, the Paystack webhook. They are
layers too, merged into `AppRoutes` in `src/http/server.ts`.

### Serving

`HttpRouter.serve(AppRoutes)` plus `BunHttpServer.layer({ port })` gives a
running server; `HttpRouter.toWebHandler(AppRoutes)` gives a
`(Request) => Promise<Response>` function instead (used by tests, and by the
serverless conversion).

---

## 16. Persistence: Redis, rate limiting, circuit breaker, queues

These come from `effect/persistence` and all build on one generic `Redis`
service:

- **`Redis`**: a minimal interface (`send`, `eval`, ...). `BunRedis.layer`
  implements it with Bun's native client. `src/platform/redis.ts` wraps two
  instances as `CacheRedis` and `JobsRedis`, and `CacheRedis.asRedis` /
  `JobsRedis.asRedis` provide one of them _as_ the generic `Redis` to modules
  that need it, so the cache and jobs instances can never be mixed up.
- **`RateLimiter`**: token-bucket and fixed-window limits stored in Redis.
  `src/platform/rate-limits.ts` wraps it as `RateLimits`, which returns a
  decision (`Allowed` / `Limited` / `Unavailable`) instead of failing.
- **`CircuitBreaker`**: stops calling a failing dependency for a while. Here
  it guards the rate-limit store, with a classifier so that only Redis errors
  count as failures, never 429s.
- **`PersistedQueue`**: a durable job queue. `queue.offer(job, { id })` adds a
  job (the `id` deduplicates); `queue.take(handler)` takes one job, runs the
  handler, and acknowledges or schedules a retry. `src/jobs/consume.ts` runs
  N `take` loops per queue.

---

## 17. Bridging Promises and callbacks

Real code mixes Effect with Promise-based libraries (AWS SDK, nodemailer,
Better Auth).

**Promise → Effect:**

```ts
Effect.tryPromise({
  try: (signal) => client.send(command, { abortSignal: signal }),
  catch: (cause) => new StorageError({ operation, cause }),
});
```

- `Effect.tryPromise` for promises that can reject (you map the rejection to a
  typed error). The `signal` aborts the request if the effect is interrupted,
  for example by a timeout.
- `Effect.promise(() => p)` for promises that should never reject (a rejection
  becomes a defect).

**Effect → Promise** (when a library calls _you_ and expects a Promise):

```ts
// src/auth/auth.ts
const context = yield* Effect.context<never>();   // capture the layer's services
const run = Effect.runPromiseWith(context);       // run effects with them later
...
sendEmail: (email) => run(emails.enqueue(email).pipe(...)),
```

Better Auth calls `sendEmail` from its own Promise code, so the layer captures
its services at build time and runs effects with them on demand. The same trick
lets Better Auth's database queries run on the Effect Postgres client.

---

## 18. A request, end to end

Follow `GET /v1/me` with a session cookie:

1. **Bun** receives the request (`BunHttpServer` in `src/http/server.ts`).
2. **Global middleware** (`src/http/middleware.ts`), outermost first: resolve
   the client IP, assign `x-request-id` and annotate logs, start the access
   log timer, then security headers, failure rendering, body limit and timeout.
3. **Routing**: `/v1/me` matches the `getMe` endpoint of the `account` group.
4. **HttpApi middleware**: `RateLimit` consumes a token (`src/http/rate-limit.ts`
   → `RateLimits` → `RateLimiter` → Redis), then `Authenticated` asks Better
   Auth for the session and provides `CurrentUser`.
5. **Handler** (`account.handlers.ts`) reads `CurrentUser` and calls
   `AccountService.getProfile`.
6. **Service** (`account.service.ts`) queries Postgres through Drizzle on
   `@effect/sql-pg` (one span for the method, one for the SQL).
7. **Response**: the `Profile` schema encodes the row (dates become ISO
   strings); a `NotFound` would become a 404 problem instead.
8. **Back out through the middleware**: headers are added, the access log line
   and the duration metric are recorded with the request id.

And a sign-up email: Better Auth's hook → `EmailService.enqueue` (validates
with the template schema) → `EmailQueue.offer` (Redis) → the worker's
`consume` loop → `makeDeliverEmail` (render, throttle, `Mailer.send`) → Mailpit.

---

## 19. Testing with Effect

Because dependencies are services, tests replace them instead of mocking
modules.

**A fake service:**

```ts
const fakeLimits = Layer.succeed(
  RateLimits,
  RateLimits.of({ consume: () => Effect.succeed({ _tag: "Allowed", limit: 10, remaining: 9 }) }),
);
```

**Running an effect in a test:**

```ts
const exit = await program.pipe(Effect.provide(layers), Effect.exit, Effect.runPromise);
expect(exit._tag).toBe("Success");
```

`Effect.flip` swaps success and error, handy for asserting on an error:
`const error = await Effect.runPromise(Effect.flip(client.getReadiness()))`.

**Sharing a built layer across tests:** `ManagedRuntime.make(layer)` builds it
once; `runtime.runPromise(effect)` runs effects with it; `runtime.dispose()` in
`afterAll` closes it (`tests/integration/*.test.ts`).

**HTTP:**

- `HttpApiTest.groups(Api, ["health"])` gives a typed in-memory client for
  some groups (`tests/unit/api/health.test.ts`).
- `HttpRouter.toWebHandler(layer)` gives a real `Request → Response` function
  to test middleware and routes (`tests/unit/http/*.test.ts`).

**Config:** `testConfig({...})` in `tests/support/config.ts` provides a
`ConfigProvider` with test values.

---

## 20. Glossary

| Term                        | Meaning                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| **Effect**                  | A lazy description of a program: `Effect<Success, Error, Requirements>`. |
| **`Effect.gen` / `yield*`** | Write effects sequentially, like async/await.                            |
| **`Effect.fn`**             | Define a function returning an effect, traced as a named span.           |
| **Failure**                 | An expected, typed error (in `E`).                                       |
| **Defect**                  | An unexpected error (bug), not in the type.                              |
| **`Exit`**                  | The outcome of running an effect: success value or `Cause`.              |
| **`Cause`**                 | Why an effect failed: failures, defects, interruptions.                  |
| **Interruption**            | Cancelling a fiber; finalizers still run.                                |
| **Service**                 | An interface + key (`Context.Service`) that code asks for with `yield*`. |
| **`Context.Reference`**     | A service with a default value.                                          |
| **Layer**                   | A recipe that builds services: `Layer<Out, Error, In>`.                  |
| **Provide**                 | Satisfy an effect's or layer's requirements.                             |
| **Scope**                   | A lifetime that runs finalizers when it closes.                          |
| **`acquireRelease`**        | Open a resource and register how to close it.                            |
| **Fiber**                   | A lightweight concurrent execution of an effect.                         |
| **Runtime**                 | What actually runs effects (`runPromise`, `runMain`, `ManagedRuntime`).  |
| **Schema**                  | A data definition that is both a type and a validator/encoder.           |
| **`Config`**                | A typed, validated description of an environment variable.               |
| **`Redacted`**              | A wrapper that hides a secret from logs.                                 |
| **Schedule**                | A policy for repeating or retrying.                                      |
| **Span**                    | A timed step in a trace.                                                 |
| **`HttpApi`**               | The schema-first HTTP contract (groups of endpoints).                    |
| **Problem**                 | An RFC 9457 error response class (`HttpApiError.Problem`).               |

---

## 21. Common mistakes

- **Forgetting `yield*`.** `db.insert(...)` on its own line inside a generator
  builds the query effect and throws it away; nothing is written. Always
  `yield*` it (or return it).
- **Forgetting `return` before `yield* error`.** It still fails, but
  TypeScript keeps checking the code after it as if it could run.
- **Calling `Effect.runPromise` inside services.** Services return effects;
  only entry points, tests and Promise bridges run them.
- **`try/catch` around effects.** Effects do not throw; use
  `Effect.catchTag`, `Effect.mapError`, `Effect.exit`.
- **`Effect.promise` for something that can fail.** A rejection becomes a
  defect (a 500). Use `Effect.tryPromise` with a typed error when failure is
  expected.
- **Reading `process.env` directly.** Add it to `src/config.ts` instead, so it
  is validated at boot and replaceable in tests.
- **Creating a second layer instance by accident.** `Layer.provide(Database.layer)`
  everywhere is fine (memoized). Calling a function that _returns a new layer_
  each time (like `BunRedis.layer({...})`) creates a new instance each time,
  which is why `redis.ts` builds each Redis layer once.
- **High-cardinality metric labels.** Never label metrics with paths, ids,
  emails or IPs.

---

## 22. Where to learn more

- Effect's own guides ship inside the package:
  `node_modules/effect/ai-docs/src/` (services, layers, errors, schema,
  HTTP server and client, testing, observability). They match the installed
  version exactly.
- https://effect.website for the official documentation.
- In this repo: `AGENTS.md` (conventions), `README.md` (how things fit),
  `docs/effect-v4-migration-plan.md` (why each design decision was made).

A good first exercise: add a `GET /v1/me/sessions` endpoint that lists the
signed-in user's sessions. You will touch every idea in this guide: a schema,
an endpoint in `account.api.ts`, a service method with a Drizzle query, a
handler, and a test.
