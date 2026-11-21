import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Api } from "../../http/api";
import { NotReady } from "./health.error";
import { HealthService } from "./health.service";

export const HealthHandlersNoDeps = HttpApiBuilder.group(
  Api,
  "health",
  Effect.fn(function* (handlers) {
    const health = yield* HealthService;

    return handlers
      .handle("getHealth", () => Effect.succeed({ ok: true as const }))
      .handle("getReadiness", () =>
        Effect.gen(function* () {
          const { ok, draining, checks } = yield* health.readiness;
          if (!ok) return yield* new NotReady({ draining, checks });
          return { ok: true as const, checks };
        }),
      );
  }),
);

export const HealthHandlers = HealthHandlersNoDeps.pipe(Layer.provide(HealthService.layer));
