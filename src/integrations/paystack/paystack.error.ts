import { Schema } from "effect";

/**
 * - Network: the request never got an answer (connection, DNS, timeout).
 *   For a money-moving call the outcome is unknown: verify by reference.
 * - Api: Paystack answered and refused (`status: false` or a 4xx/5xx).
 * - Decode: Paystack answered with a body we could not read.
 */
export class PaystackError extends Schema.TaggedError<PaystackError>()("PaystackError", {
  reason: Schema.Literals(["Network", "Api", "Decode"]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
