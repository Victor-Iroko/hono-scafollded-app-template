// API process entry point. SIGTERM flips /readyz to 503, waits
// HTTP_SHUTDOWN_GRACE_MS, drains in-flight requests, closes every resource in
// reverse build order, and exits 0.
import { Layer } from "effect";
import { HttpServerLive } from "./http/server";
import { ObservabilityLive } from "./platform/observability";
import { runLongLived } from "./platform/run-main";

runLongLived(Layer.launch(HttpServerLive.pipe(Layer.provide(ObservabilityLive))));
