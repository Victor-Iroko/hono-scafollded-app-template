// Mounts Better Auth's own handler at /api/auth/*. It has its own Redis-backed
// limiter, so it sits outside the HttpApi rate limit.
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AUTH_BASE_PATH, BetterAuth, CLIENT_IP_HEADER } from "./auth";

export const AuthRoute = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* BetterAuth;

    return HttpRouter.add("*", `${AUTH_BASE_PATH}/*`, (request) =>
      Effect.gen(function* () {
        const web = yield* HttpServerRequest.toWeb(request);
        const headers = new Headers(web.headers);
        headers.delete(CLIENT_IP_HEADER);
        if (Option.isSome(request.remoteAddress)) {
          headers.set(CLIENT_IP_HEADER, request.remoteAddress.value);
        }

        const response = yield* Effect.promise(() => auth.handler(new Request(web, { headers })));
        return HttpServerResponse.fromWeb(response);
      }),
    );
  }),
).pipe(Layer.provide(BetterAuth.layer));
