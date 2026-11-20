import { Schema } from "effect";

export const HealthResponse = Schema.Struct({ ok: Schema.Literal(true) });
