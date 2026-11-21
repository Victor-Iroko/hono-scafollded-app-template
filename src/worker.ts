// Worker process entry point. SIGTERM interrupts the workers; an interrupted
// job is released and redelivered, so nothing is lost. Exits 0 on shutdown.
import { Layer } from "effect";
import { WorkerLive } from "./jobs/worker";
import { ObservabilityLive } from "./platform/observability";
import { runLongLived } from "./platform/run-main";

runLongLived(Layer.launch(WorkerLive.pipe(Layer.provide(ObservabilityLive))));
