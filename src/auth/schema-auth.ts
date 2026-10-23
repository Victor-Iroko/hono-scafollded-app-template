import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";
import { createAuth } from "./auth";

// Schema and OpenAPI generation only read the config: no database or Redis
// connection is opened, so these tools work without the app environment.
const schemaEnv = {
  BETTER_AUTH_SECRET: "generation-only-secret-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_TRUSTED_ORIGINS: [],
  AUTH_REQUIRE_EMAIL_VERIFICATION: false,
  AUTH_TRUST_PROXY_HEADERS: false,
};

export function createSchemaAuth() {
  return createAuth(schemaEnv, drizzle.mock({ schema }));
}
