import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/http";
import { PaystackClient } from "../../../src/integrations/paystack/paystack.client";
import type { WebhookEvent } from "../../../src/integrations/paystack/paystack.schema";
import {
  paystackWebhookRoute,
  verifyWebhookSignature,
} from "../../../src/integrations/paystack/paystack.webhook";
import { testConfig } from "../../support/config";

const SECRET = "sk_test_secret";
const config = testConfig({ PAYSTACK_SECRET_KEY: SECRET });

type Reply = Response | "network-error";

/** A Paystack client over a scripted HttpClient; records every request it sends. */
function makeClient(replies: ReadonlyArray<Reply>) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const http = HttpClient.make((request) => {
    requests.push(request);
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
    if (reply === "network-error") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection reset" }),
        }),
      );
    }
    // undici and Bun ship separate `Response` typings for the same runtime class.
    const web = reply.clone() as unknown as Parameters<typeof HttpClientResponse.fromWeb>[1];
    return Effect.succeed(HttpClientResponse.fromWeb(request, web));
  });
  const layer = PaystackClient.layerNoDeps.pipe(
    Layer.provide([Layer.succeed(HttpClient.HttpClient, http), config]),
  );
  const run = <A, E>(f: (client: PaystackClient["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      return yield* f(yield* PaystackClient);
    }).pipe(Effect.provide(layer), Effect.exit, Effect.runPromise);
  return { requests, run };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const initializeBody = { amount: 5_000, email: "ada@example.com", reference: "order-1" };

describe("PaystackClient", () => {
  test("unwraps the envelope, decodes data and sends the bearer key", async () => {
    const { run, requests } = makeClient([
      json({
        status: true,
        message: "ok",
        data: { authorization_url: "https://pay", access_code: "ac", reference: "order-1" },
      }),
    ]);
    const exit = await run((client) => client.initializeTransaction(initializeBody));

    expect(exit).toMatchObject({ _tag: "Success", value: { reference: "order-1" } });
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(requests[0]?.url).toBe("https://api.paystack.co/transaction/initialize");
  });

  test("turns status:false into an Api error with Paystack's message", async () => {
    const { run } = makeClient([json({ status: false, message: "Duplicate reference" }, 400)]);
    const exit = await run((client) => Effect.flip(client.initializeTransaction(initializeBody)));

    expect(exit).toMatchObject({
      _tag: "Success",
      value: { reason: "Api", message: "Duplicate reference", status: 400 },
    });
  });

  test("reports an unreadable body as a Decode error", async () => {
    const { run } = makeClient([new Response("<html>bad gateway</html>", { status: 502 })]);
    const exit = await run((client) => Effect.flip(client.verifyTransaction("order-1")));
    expect(exit).toMatchObject({ _tag: "Success", value: { reason: "Decode", status: 502 } });
  });

  test("retries reads after a network error", async () => {
    const { run, requests } = makeClient([
      "network-error",
      json({ status: true, message: "ok", data: { account_number: "01", account_name: "Ada" } }),
    ]);
    const exit = await run((client) => client.resolveAccount("01", "058"));

    expect(exit._tag).toBe("Success");
    expect(requests).toHaveLength(2);
  });

  test("never retries a call that moves money", async () => {
    const { run, requests } = makeClient(["network-error"]);
    const exit = await run((client) =>
      Effect.flip(
        client.initiateTransfer({
          source: "balance",
          amount: 1_000,
          recipient: "RCP_1",
          reference: "payout-1",
        }),
      ),
    );

    expect(exit).toMatchObject({ _tag: "Success", value: { reason: "Network" } });
    expect(requests).toHaveLength(1);
  });
});

describe("Paystack webhooks", () => {
  const body = JSON.stringify({ event: "charge.success", data: { reference: "order-1" } });
  const sign = (payload: string) => createHmac("sha512", SECRET).update(payload).digest("hex");

  test("verifies the HMAC-SHA512 signature of the raw body", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyWebhookSignature(`${body} `, sign(body), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "not-hex", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
  });

  const received: WebhookEvent[] = [];
  const { handler, dispose } = HttpRouter.toWebHandler(
    paystackWebhookRoute("/webhooks/paystack", (event) =>
      Effect.sync(() => received.push(event)),
    ).pipe(Layer.provide([config, HttpServer.layerServices])),
    { disableLogger: true },
  );
  afterEach(() => {
    received.length = 0;
  });

  const post = (payload: string, signature?: string) =>
    handler(
      new Request("http://localhost/webhooks/paystack", {
        method: "POST",
        body: payload,
        headers: signature ? { "x-paystack-signature": signature } : {},
      }),
    );

  test("accepts a signed event and hands it to the handler", async () => {
    const response = await post(body, sign(body));

    expect(response.status).toBe(200);
    expect(received).toEqual([{ event: "charge.success", data: { reference: "order-1" } }]);
  });

  test("rejects an unsigned or tampered event without calling the handler", async () => {
    expect((await post(body)).status).toBe(401);
    expect((await post(body.replace("order-1", "order-2"), sign(body))).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  test("rejects a signed body that is not a Paystack event", async () => {
    const junk = JSON.stringify({ hello: "world" });
    expect((await post(junk, sign(junk))).status).toBe(400);
    await dispose();
  });
});
