// End-to-end auth over HTTP. Requires Postgres and Redis from docker-compose.test.yml.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { AppRoutes } from "../../src/http/server";
import { ShutdownSignal } from "../../src/http/shutdown";
import { Database } from "../../src/platform/database";
import { testConfig } from "../support/config";
import { migrateTestDatabase, truncateTables } from "../support/database";

const ORIGIN = "http://localhost:3000";
const config = testConfig();

const database = ManagedRuntime.make(Database.layer.pipe(Layer.provide(config)));
const { handler, dispose } = HttpRouter.toWebHandler(
  AppRoutes.pipe(Layer.provide([ShutdownSignal.layer, HttpServer.layerServices, config])),
  { disableLogger: true },
);

const request = (path: string, init: RequestInit = {}) =>
  handler(
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { origin: ORIGIN, "content-type": "application/json", ...init.headers },
    }),
  );

const sessionCookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

beforeAll(async () => {
  await database.runPromise(
    Effect.andThen(
      migrateTestDatabase,
      truncateTables("user", "session", "account", "verification"),
    ),
  );
});

afterAll(async () => {
  await dispose();
  await database.dispose();
});

describe("auth", () => {
  const credentials = { name: "Ada", email: "ada@example.com", password: "correct-horse-battery" };
  let cookie = "";

  test("GET /v1/me without a session is a 401 problem", async () => {
    const response = await request("/v1/me");

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  test("sign-up creates the user and starts a session", async () => {
    const response = await request("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify(credentials),
    });

    expect(response.status).toBe(200);
    cookie = sessionCookie(response);
    expect(cookie).toContain("better-auth.session_token=");
  });

  test("GET /v1/me returns the signed-in user's profile", async () => {
    const response = await request("/v1/me", { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "Ada",
      email: "ada@example.com",
      emailVerified: false,
    });
    expect(response.headers.get("x-ratelimit-limit")).toBe("100");
  });

  test("sign-in with the wrong password is rejected", async () => {
    const response = await request("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: credentials.email, password: "wrong-password-123" }),
    });

    expect(response.status).toBe(401);
  });

  test("sign-up with an existing email is rejected", async () => {
    const response = await request("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify(credentials),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
