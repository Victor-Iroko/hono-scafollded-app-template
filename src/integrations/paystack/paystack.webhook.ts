// Paystack webhooks. Paystack signs the exact raw body with HMAC-SHA512 using
// the secret key and sends it in `x-paystack-signature`.
//
// Mount the route next to the other routes in src/http/server.ts:
//
//   paystackWebhookRoute("/webhooks/paystack", (event) =>
//     PaymentsQueue.use((queue) => queue.offer(event, { id: `${event.event}:${event.data.reference}` })),
//   )
//
// Keep the handler fast: queue the work and let a job do it. Paystack retries
// deliveries, so derive the job id from the event to drop duplicates.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/http";
import { PaystackConfig } from "../../config";
import { BadRequest, Unauthorized } from "../../http/errors";
import { WebhookEvent } from "./paystack.schema";

export const SIGNATURE_HEADER = "x-paystack-signature";
const SIGNATURE = /^[a-f\d]{128}$/i;

/** Constant-time check of Paystack's signature over the raw request body. */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secretKey: string,
): boolean {
  if (!signature || !SIGNATURE.test(signature)) return false;
  const expected = createHmac("sha512", secretKey).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export const paystackWebhookRoute = <E, R>(
  path: `/${string}`,
  onEvent: (event: WebhookEvent) => Effect.Effect<void, E, R>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { secretKey } = yield* PaystackConfig;
      const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(WebhookEvent));

      return HttpRouter.add("POST", path, (request) =>
        Effect.gen(function* () {
          // The signature covers the raw bytes, so read text before any JSON parsing.
          const rawBody = yield* request.text;
          if (
            !verifyWebhookSignature(
              rawBody,
              request.headers[SIGNATURE_HEADER],
              Redacted.value(secretKey),
            )
          ) {
            return yield* HttpServerRespondable.toResponse(
              new Unauthorized({ detail: "Invalid signature" }),
            );
          }

          const event = yield* Effect.exit(decodeEvent(rawBody));
          if (event._tag === "Failure") {
            return yield* HttpServerRespondable.toResponse(
              new BadRequest({ detail: "Invalid event payload" }),
            );
          }

          yield* onEvent(event.value).pipe(
            Effect.withSpan("Paystack.webhook", {
              attributes: { "paystack.event": event.value.event },
            }),
          );
          return HttpServerResponse.jsonUnsafe({ received: true });
        }),
      );
    }),
  );
