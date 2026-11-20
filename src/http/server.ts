import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { HealthHandlers } from "../api/health/health.handlers";
import { HttpConfig } from "../config";
import { Api } from "./api";

/** Every route the server answers, without the server itself (tests use this). */
export const ApiRoutes = HttpApiBuilder.layer(Api).pipe(Layer.provide([HealthHandlers]));

export const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port } = yield* HttpConfig;
    return HttpRouter.serve(ApiRoutes).pipe(
      Layer.provide(BunHttpServer.layer({ hostname: host, port })),
    );
  }),
);
