# Entry point: Fetch handler

`HttpRouter.toWebHandler` turns the same `AppRoutes` the server uses into a
`(Request) => Promise<Response>` handler. Build it at module scope: the layer
graph (pools, clients) is built once per function instance and reused across
invocations. Never build it inside the request.

## `src/serverless.ts`: add

```ts
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { OtlpExporter } from "effect/observability";
import * as Sentry from "@sentry/effect/server";
import { AppRoutes } from "./http/server";
import { ShutdownSignal } from "./http/shutdown";
import { ObservabilityLive } from "./platform/observability";

const Infrastructure = Layer.mergeAll(
  ShutdownSignal.layer,
  ObservabilityLive,
  HttpServer.layerServices,
);

const { handler } = HttpRouter.toWebHandler(AppRoutes.pipe(Layer.provide(Infrastructure)));

// Separate runtime only to reach the OTLP flusher (present when OTEL_EXPORTER_OTLP_ENDPOINT is set).
const telemetry = ManagedRuntime.make(ObservabilityLive);
const flushTelemetry = () =>
  telemetry.runPromise(
    Effect.serviceOption(OtlpExporter.Flusher).pipe(
      Effect.flatMap((flusher) => (flusher._tag === "Some" ? flusher.value.flush : Effect.void)),
      Effect.andThen(Effect.promise(() => Sentry.flush(2_000))),
      Effect.ignore,
    ),
  );

export default {
  async fetch(request: Request, context?: { waitUntil?: (promise: Promise<unknown>) => void }) {
    const response = await handler(request);
    const flushed = flushTelemetry();
    if (context?.waitUntil) context.waitUntil(flushed);
    else await flushed;
    return response;
  },
};
```

Check before relying on it:

- Two `ObservabilityLive` builds would initialize Sentry twice and run two
  exporters. Prefer providing a single built `ObservabilityLive` to both: build
  a `ManagedRuntime` of `Infrastructure`, then pass its `memoMap` to
  `toWebHandler({ memoMap })` so the routes reuse the same layers. Verify the
  flush reaches the collector with a debug collector (see
  `docs/effect-v4-migration-plan.md` §6.3 for how the long-running build was verified).
- On Vercel Node, `waitUntil` comes from `@vercel/functions`; on Lambda there
  is none, so the flush is awaited.

## Platform config

- **Vercel (Node):** export the handler from `api/index.ts` (`export { default } from "../src/serverless"`) and rewrite all paths to it in `vercel.json` (`"rewrites": [{ "source": "/(.*)", "destination": "/api" }]`).
- **Vercel (Bun):** copy `assets/vercel.json` (`bunVersion`) and add the same rewrite.
- **AWS Lambda:** wrap the Fetch handler with your adapter of choice (Lambda function URLs deliver events, not `Request`s).

## Drop from the long-running entry

- `DrainBeforeStop` and `BunHttpServer` in `src/http/server.ts` are only used by
  `src/main.ts`; keep `main.ts` for local development or delete it.
- `S3_AUTO_CREATE_BUCKET` must stay off: create buckets in IaC.
- `/readyz` still works but platforms rarely call it; keep it for uptime checks.
