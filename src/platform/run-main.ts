// Entry point for long-running processes (API, worker).
//
// SIGTERM/SIGINT interrupt the program, every layer finalizer runs, and the
// process exits 0: a requested shutdown is the normal way these processes end,
// so orchestrators must not report it as a failure. Real failures keep
// Effect's default exit codes (1 for errors).
import { BunRuntime } from "@effect/platform-bun";
import { Cause, type Effect, Exit, Runtime } from "effect";

const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return onExit(0);
  Runtime.defaultTeardown(exit, onExit);
};

export const runLongLived = <E, A>(program: Effect.Effect<A, E>) =>
  BunRuntime.runMain(program, { teardown });
