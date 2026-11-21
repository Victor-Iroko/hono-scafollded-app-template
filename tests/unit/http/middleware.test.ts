import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Conflict } from "../../../src/http/errors";
import { HttpMiddlewareLive } from "../../../src/http/middleware";
import { testConfig } from "../../support/config";

/** The shape the Drizzle rc stack fails with on a unique violation. */
const uniqueViolation = Object.assign(new Error("duplicate key"), {
  code: "23505",
  severity: "ERROR",
  constraint: "users_email_key",
});

const TestRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/ok", HttpServerResponse.jsonUnsafe({ ok: true })),
  HttpRouter.add("GET", "/typed", Effect.fail(new Conflict({ detail: "taken" }))),
  HttpRouter.add("GET", "/defect", Effect.die(new Error("kaboom"))),
  HttpRouter.add("GET", "/duplicate", Effect.die(uniqueViolation)),
  HttpRouter.add("GET", "/slow", Effect.as(Effect.never, HttpServerResponse.empty())),
  HttpRouter.add(
    "POST",
    "/echo",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return HttpServerResponse.text(yield* request.text);
    }),
  ),
);

const { handler, dispose } = HttpRouter.toWebHandler(
  Layer.mergeAll(TestRoutes, HttpMiddlewareLive).pipe(
    Layer.provide(
      testConfig({
        TRUSTED_ORIGINS: "https://app.example.com",
        HTTP_MAX_BODY_BYTES: "1024",
        HTTP_REQUEST_TIMEOUT_MS: "1000",
      }),
    ),
  ),
  { disableLogger: true },
);

afterAll(() => dispose());

const request = (path: string, init?: RequestInit) =>
  handler(new Request(`http://localhost${path}`, init));

describe("http middleware", () => {
  test("adds a request id and security headers", async () => {
    const response = await request("/ok");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  test("keeps a well-formed incoming request id and replaces a malformed one", async () => {
    const kept = await request("/ok", { headers: { "x-request-id": "abc-123" } });
    const replaced = await request("/ok", { headers: { "x-request-id": "bad id!" } });

    expect(kept.headers.get("x-request-id")).toBe("abc-123");
    expect(replaced.headers.get("x-request-id")).not.toBe("bad id!");
  });

  test("answers unknown routes with a 404 problem", async () => {
    const response = await request("/missing");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toEqual({ type: "about:blank", title: "Not Found", status: 404 });
  });

  test("passes typed problems through unchanged", async () => {
    const response = await request("/typed");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ title: "Conflict", detail: "taken" });
  });

  test("hides defects behind a generic 500 problem", async () => {
    const response = await request("/defect");
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("kaboom");
    expect(JSON.parse(body)).toMatchObject({ status: 500, title: "Internal Server Error" });
  });

  test("maps a database unique violation to a 409 problem", async () => {
    const response = await request("/duplicate");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ detail: "Resource already exists" });
  });

  test("rejects bodies over the configured limit with 413", async () => {
    const response = await request("/echo", { method: "POST", body: "x".repeat(2_048) });
    expect(response.status).toBe(413);
  });

  test("times out slow requests with a 503 problem", async () => {
    const response = await request("/slow");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ detail: "Request timed out" });
  });

  test("answers CORS preflight for trusted origins only", async () => {
    const preflight = (origin: string) =>
      request("/ok", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      });

    const trusted = await preflight("https://app.example.com");
    const untrusted = await preflight("https://evil.example.com");

    expect(trusted.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(trusted.headers.get("access-control-allow-credentials")).toBe("true");
    // A single allowed origin is always echoed; the browser rejects any other caller.
    expect(untrusted.headers.get("access-control-allow-origin")).not.toBe(
      "https://evil.example.com",
    );
  });
});
