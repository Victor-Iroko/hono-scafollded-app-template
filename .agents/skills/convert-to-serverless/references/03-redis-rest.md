# Redis over Upstash REST

`CacheRedis` today is `BunRedis` (TCP). Every consumer goes through Effect's
generic `Redis` service (`effect/persistence/Redis`), so swapping the
implementation keeps `RateLimits`, the circuit breaker and Better Auth's
rate-limit storage unchanged.

## `src/platform/redis.ts`: rewrite

Implement `Redis.make` over Upstash's REST API. A command is a JSON array
POSTed to the REST URL; the reply is `{ result }` or `{ error }`.

```ts
const send = <A>(command: string, ...args: ReadonlyArray<string>) =>
  http
    .execute(
      HttpClientRequest.post(config.restUrl).pipe(
        HttpClientRequest.bearerToken(Redacted.value(config.restToken)),
        HttpClientRequest.bodyJsonUnsafe([command, ...args]),
      ),
    )
    .pipe(
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(
          Schema.Struct({
            result: Schema.optionalKey(Schema.Unknown),
            error: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
      Effect.flatMap((reply) =>
        reply.error !== undefined
          ? Effect.fail(new Error(reply.error))
          : Effect.succeed(reply.result as A),
      ),
      Effect.mapError((cause) => new Redis.RedisError({ cause })),
    );

// Inside the CacheRedis layer's Effect.gen:
const makeRestRedis = Effect.gen(function* () {
  return yield* Redis.make({
    send,
    // REST is stateless: a "connection" is the same request path.
    connect: Effect.succeed({ send, close: Effect.void }),
    subscribe: () =>
      Effect.fail(
        new Redis.RedisError({ cause: new Error("Pub/sub is not available over Upstash REST") }),
      ),
  });
});
```

Keep `CacheRedis` / `CacheRedis.asRedis` as the public names, and replace the
`RedisConfig` group with `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
(`Config.redacted` for the token). Remove `JobsRedis` together with the job queue
(see `02-jobs-qstash.md`).

## Verify

The rate limiter stores its token buckets with Lua scripts through
`Redis.eval`. Run `tests/integration/rate-limits.test.ts` against the local REST
shim (`05-local-dev.md`) before going further: a burst up to capacity, then
`Limited`, and `Unavailable` when the shim is stopped. If scripts fail over REST,
check that `Redis.make` sends `EVALSHA`/`EVAL` arguments as strings.
