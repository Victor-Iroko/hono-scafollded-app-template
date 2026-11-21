// Token-bucket rate limiting backed by the cache Redis, shared by every API
// instance. Each bucket holds `capacity` tokens and refills evenly over
// `refillWindow`, so clients get bursts up to `capacity` and a sustained rate
// of capacity / refillWindow.
//
// The store call is guarded: a 100 ms timeout, then a circuit breaker that
// opens when Redis keeps failing. Callers get a decision, never an error, and
// choose what "Unavailable" means for them (fail open or closed).
import { Cause, Context, Duration, Effect, Exit, Layer, Metric, Stream } from "effect";
import { CircuitBreaker, RateLimiter } from "effect/persistence";
import { CacheRedis } from "./redis";

const STORE_TIMEOUT = Duration.millis(100);

// Attributed by decision only: keys contain client addresses (unbounded cardinality).
const decisions = Metric.counter("rate_limit.decisions", {
  description: "Rate-limit decisions (Allowed, Limited, Unavailable)",
  incremental: true,
});
const BREAKER_KEY = "rate-limit-store";

export interface ConsumeOptions {
  readonly key: string;
  readonly capacity: number;
  readonly refillWindow: Duration.Input;
  /** Tokens this call takes. Defaults to 1. */
  readonly cost?: number;
}

export type RateLimitDecision =
  | { readonly _tag: "Allowed"; readonly limit: number; readonly remaining: number }
  | { readonly _tag: "Limited"; readonly limit: number; readonly retryAfter: Duration.Duration }
  | { readonly _tag: "Unavailable" };

const isLimitExceeded = (error: unknown): error is RateLimiter.RateLimiterError =>
  error instanceof RateLimiter.RateLimiterError && error.reason._tag === "RateLimitExceeded";

// A rejected request is the store working as intended; only store errors and
// timeouts count against Redis.
const classifyStoreCall = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit) || isLimitExceeded(Cause.squash(exit.cause))
    ? CircuitBreaker.success
    : CircuitBreaker.failure();

export class RateLimits extends Context.Service<
  RateLimits,
  { readonly consume: (options: ConsumeOptions) => Effect.Effect<RateLimitDecision> }
>()("app/RateLimits") {
  static readonly layer = Layer.effect(
    RateLimits,
    Effect.gen(function* () {
      const limiter = yield* RateLimiter.RateLimiter;
      const breaker = yield* CircuitBreaker.make({
        tripPolicy: CircuitBreaker.rate({ threshold: 0.5, size: 20, minimumCalls: 10 }),
        openDuration: Duration.seconds(5),
      });

      // Log state changes once, not per request.
      yield* breaker.transitions.pipe(
        Stream.runForEach((transition) =>
          Effect.logWarning("rate limit store circuit changed").pipe(
            Effect.annotateLogs({ from: transition.from, to: transition.to }),
          ),
        ),
        Effect.forkScoped,
      );

      const decide = Effect.fn("RateLimits.consume")(function* (options: ConsumeOptions) {
        const exit = yield* limiter
          .consume({
            algorithm: "token-bucket",
            onExceeded: "fail",
            key: options.key,
            limit: options.capacity,
            window: options.refillWindow,
            tokens: options.cost ?? 1,
          })
          .pipe(
            Effect.timeout(STORE_TIMEOUT),
            breaker.execute({ key: BREAKER_KEY, classify: classifyStoreCall }),
            Effect.exit,
          );

        if (Exit.isSuccess(exit)) {
          return {
            _tag: "Allowed",
            limit: exit.value.limit,
            remaining: exit.value.remaining,
          } as const;
        }
        const error = Cause.squash(exit.cause);
        if (
          error instanceof RateLimiter.RateLimiterError &&
          error.reason._tag === "RateLimitExceeded"
        ) {
          return {
            _tag: "Limited",
            limit: error.reason.limit,
            retryAfter: error.reason.retryAfter,
          } as const;
        }
        // An open circuit was already logged on transition; log the rest.
        if (!(error instanceof CircuitBreaker.CircuitBreakerError)) {
          yield* Effect.logWarning("rate limit store unavailable").pipe(
            Effect.annotateLogs({ cause: exit.cause }),
          );
        }
        return { _tag: "Unavailable" } as const;
      });

      const consume = (options: ConsumeOptions) =>
        Effect.tap(decide(options), (decision) =>
          Metric.update(Metric.withAttributes(decisions, { decision: decision._tag }), 1),
        );

      return RateLimits.of({ consume });
    }),
  ).pipe(
    Layer.provide([CircuitBreaker.layerStoreMemory(), RateLimiter.layer]),
    Layer.provide(RateLimiter.layerStoreRedis({ prefix: "ratelimit:" })),
    Layer.provide(CacheRedis.asRedis),
  );
}
