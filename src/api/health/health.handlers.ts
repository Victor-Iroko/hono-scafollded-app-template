import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Api } from "../../http/api";

export const HealthHandlers = HttpApiBuilder.group(Api, "health", (handlers) =>
  handlers.handle("getHealth", () => Effect.succeed({ ok: true as const })),
);
