// API process entry point. SIGINT/SIGTERM interrupt the program, and every
// layer's finalizer runs in reverse build order.
import { BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";
import { HttpServerLive } from "./http/server";
import { ObservabilityLive } from "./platform/observability";

const MainLive = HttpServerLive.pipe(Layer.provide(ObservabilityLive));

BunRuntime.runMain(Layer.launch(MainLive));
