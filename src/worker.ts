import { initEnv } from "./core/env";
import { initInstrumentation } from "./core/instrumentation";
import { getLogger } from "./core/logger";
import { closeQueues } from "./core/queue";
import { closeSmtp } from "./integrations/email";
import { startWorkers } from "./core/worker";

initEnv();
initInstrumentation();

const workers = startWorkers();
getLogger().info({ pid: process.pid }, "worker started");

async function shutdown() {
  await Promise.allSettled(workers.map((worker) => worker.close()));
  await closeQueues();
  closeSmtp();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
