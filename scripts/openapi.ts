// Writes openapi.json (used by Fern). The running server serves the same
// document at /openapi.json when DOCS_ENABLED=true. No database, Redis or env
// is needed: Better Auth only reads its config to describe its endpoints.
import { drizzle } from "drizzle-orm/node-postgres";
import { Effect, Option } from "effect";
import { writeFile } from "node:fs/promises";
import { createAuth } from "../src/auth/auth";
import { buildOpenApiDocument } from "../src/http/docs";

const auth = createAuth(drizzle.mock(), {
  baseUrl: "http://localhost:3000",
  secret: "generation-only-secret-at-least-32-characters",
  trustedOrigins: [],
  requireEmailVerification: false,
  google: Option.none(),
  sendEmail: async () => {},
});

const document = await Effect.runPromise(buildOpenApiDocument(auth));
await writeFile("openapi.json", `${JSON.stringify(document, null, 2)}\n`);
