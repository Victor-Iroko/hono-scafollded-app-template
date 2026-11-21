// `Authenticated` resolves the Better Auth session for an endpoint and gives
// handlers the signed-in user:
//
//   HttpApiGroup.make("orders").add(...).middleware(Authenticated)
//   ...
//   const user = yield* CurrentUser
import { Context, Effect, Layer } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import { Unauthorized } from "../http/errors";
import { BetterAuth, type AuthSession } from "./auth";

export class CurrentUser extends Context.Service<CurrentUser, AuthSession["user"]>()(
  "app/auth/CurrentUser",
) {}

export class CurrentSession extends Context.Service<CurrentSession, AuthSession["session"]>()(
  "app/auth/CurrentSession",
) {}

export class Authenticated extends HttpApiMiddleware.Service<
  Authenticated,
  { provides: CurrentUser | CurrentSession }
>()("app/auth/Authenticated", {
  // Documents the session cookie in OpenAPI. The session itself is read from
  // the full request headers, so the __Secure- cookie prefix on HTTPS works too.
  security: {
    sessionCookie: HttpApiSecurity.apiKey({ in: "cookie", key: "better-auth.session_token" }),
  },
  error: Unauthorized,
}) {
  static readonly layerNoDeps = Layer.effect(
    Authenticated,
    Effect.gen(function* () {
      const auth = yield* BetterAuth;

      return Authenticated.of({
        sessionCookie: (httpEffect) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const session = yield* Effect.tryPromise(() =>
              auth.api.getSession({ headers: new Headers(request.headers) }),
            ).pipe(Effect.orDie, Effect.withSpan("Authenticated.getSession"));

            if (!session) return yield* new Unauthorized({ detail: "Sign-in required" });
            return yield* httpEffect.pipe(
              Effect.provideService(CurrentUser, session.user),
              Effect.provideService(CurrentSession, session.session),
            );
          }),
      });
    }),
  );

  static readonly layer = this.layerNoDeps.pipe(Layer.provide(BetterAuth.layer));
}
