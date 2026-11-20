import { Schema } from "effect";

export const HealthResponse = Schema.Struct({ ok: Schema.Literal(true) });

export const DependencyCheck = Schema.Struct({
  ok: Schema.Boolean,
  latencyMs: Schema.Number,
});

export const DependencyChecks = Schema.Struct({
  database: DependencyCheck,
});

export const ReadyResponse = Schema.Struct({
  ok: Schema.Literal(true),
  checks: DependencyChecks,
});

export type DependencyCheck = typeof DependencyCheck.Type;
export type DependencyChecks = typeof DependencyChecks.Type;
