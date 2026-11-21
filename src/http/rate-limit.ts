// Per-client token-bucket limit for API endpoints.
//
// Every endpoint behind this middleware shares the "global" bucket. An endpoint
// can get its own, stricter bucket or a higher cost with an annotation:
//
//   HttpApiEndpoint.post("signIn", "/sign-in", {...})
//     .annotate(RateLimitPolicy, { bucket: "sign-in", capacity: 5, refillWindow: "1 minute" })
//
// The client is the request's remote address; behind a proxy that is only the
// real client when TRUSTED_PROXIES is set (see ./middleware.ts).
import { Context, Duration, Effect, Layer, Option } from "effect";
import { HttpServerRequest, HttpServerRespondable, HttpServerResponse } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import { RateLimitConfig } from "../config";
import { RateLimits } from "../platform/rate-limits";
import { ServiceUnavailable, TooManyRequests } from "./errors";

export interface RateLimitOverride {
  readonly bucket?: string;
  readonly capacity?: number;
  readonly refillWindow?: Duration.Input;
  /** Tokens one request takes. Defaults to 1. */
  readonly cost?: number;
}

export const RateLimitPolicy = Context.Reference<RateLimitOverride>("app/http/RateLimitPolicy", {
  defaultValue: () => ({}),
});

export class RateLimit extends HttpApiMiddleware.Service<RateLimit>()("app/http/RateLimit", {
  error: [TooManyRequests, ServiceUnavailable],
}) {
  static readonly layerNoDeps = Layer.effect(
    RateLimit,
    Effect.gen(function* () {
      const limits = yield* RateLimits;
      const config = yield* RateLimitConfig;

      return (httpEffect, { endpoint }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const policy = Context.get(endpoint.annotations, RateLimitPolicy);
          const client = Option.getOrElse(request.remoteAddress, () => "unknown");

          const decision = yield* limits.consume({
            key: `${policy.bucket ?? "global"}:${client}`,
            capacity: policy.capacity ?? config.capacity,
            refillWindow: policy.refillWindow ?? Duration.seconds(config.refillWindowS),
            ...(policy.cost !== undefined ? { cost: policy.cost } : {}),
          });

          switch (decision._tag) {
            case "Allowed": {
              const response = yield* httpEffect;
              return HttpServerResponse.setHeaders(response, {
                "x-ratelimit-limit": String(decision.limit),
                "x-ratelimit-remaining": String(decision.remaining),
              });
            }
            case "Limited": {
              const retryAfterS = Math.max(1, Math.ceil(Duration.toSeconds(decision.retryAfter)));
              const response = yield* HttpServerRespondable.toResponse(
                new TooManyRequests({ detail: `Retry in ${retryAfterS} seconds` }),
              );
              return HttpServerResponse.setHeaders(response, {
                "retry-after": String(retryAfterS),
                "x-ratelimit-limit": String(decision.limit),
                "x-ratelimit-remaining": "0",
              });
            }
            case "Unavailable": {
              if (config.failMode === "open") return yield* httpEffect;
              return yield* HttpServerRespondable.toResponse(
                new ServiceUnavailable({ detail: "Rate limiter unavailable" }),
              );
            }
          }
        });
    }),
  );

  static readonly layer = this.layerNoDeps.pipe(Layer.provide(RateLimits.layer));
}
