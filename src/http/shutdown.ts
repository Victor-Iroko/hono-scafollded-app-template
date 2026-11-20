import { Context, Effect, Layer, Ref } from "effect";

/**
 * Process-wide draining flag. It flips when shutdown starts so `/readyz`
 * answers 503 while in-flight requests finish. Provided once, outside the HTTP
 * app, so the server and the readiness probe share the same instance.
 */
export class ShutdownSignal extends Context.Service<
  ShutdownSignal,
  {
    readonly isDraining: Effect.Effect<boolean>;
    readonly beginDraining: Effect.Effect<void>;
  }
>()("app/ShutdownSignal") {
  static readonly layer = Layer.effect(
    ShutdownSignal,
    Effect.gen(function* () {
      const draining = yield* Ref.make(false);
      return ShutdownSignal.of({
        isDraining: Ref.get(draining),
        beginDraining: Ref.set(draining, true),
      });
    }),
  );
}
