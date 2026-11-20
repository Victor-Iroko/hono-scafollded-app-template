// Worker process entry point. SIGINT/SIGTERM interrupt the workers; an
// interrupted job is released and redelivered, so nothing is lost.
import { BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";
import { WorkerLive } from "./jobs/worker";
import { ObservabilityLive } from "./platform/observability";

BunRuntime.runMain(Layer.launch(WorkerLive.pipe(Layer.provide(ObservabilityLive))));
