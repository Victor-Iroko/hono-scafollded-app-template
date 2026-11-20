// Paystack request shapes and response schemas. Amounts are in the currency's
// subunit (kobo, pesewas, cents). Response schemas list the fields the app
// reads; add fields as you need them (unknown fields are dropped on decode).
import { Schema } from "effect";

export const Currency = Schema.Literals(["NGN", "USD", "GHS", "ZAR", "KES", "XOF"]);
export type Currency = typeof Currency.Type;

export type Metadata = Readonly<Record<string, unknown>>;

// Requests. `reference` is required on every call that moves money: Paystack
// rejects a reused reference, which makes a retried call safe.

export interface InitializeTransaction {
  readonly amount: number;
  readonly email: string;
  readonly reference: string;
  readonly currency?: Currency;
  readonly callback_url?: string;
  readonly channels?: ReadonlyArray<string>;
  readonly metadata?: Metadata;
  readonly subaccount?: string;
  readonly split_code?: string;
  readonly plan?: string;
}

export interface ChargeAuthorization {
  readonly authorization_code: string;
  readonly email: string;
  readonly amount: number;
  readonly reference: string;
  readonly currency?: Currency;
  readonly metadata?: Metadata;
}

export interface CreateRefund {
  /** Transaction reference or id. */
  readonly transaction: string;
  /** Partial refund amount; omit to refund in full. */
  readonly amount?: number;
  readonly currency?: Currency;
  readonly customer_note?: string;
  readonly merchant_note?: string;
}

export interface CreateTransferRecipient {
  readonly type: "nuban" | "mobile_money" | "basa" | "authorization";
  readonly name: string;
  readonly account_number: string;
  readonly bank_code: string;
  readonly currency?: Currency;
  readonly description?: string;
  readonly metadata?: Metadata;
}

export interface InitiateTransfer {
  readonly source: "balance";
  readonly amount: number;
  readonly recipient: string;
  readonly reference: string;
  readonly reason?: string;
  readonly currency?: Currency;
}

// Responses (the `data` field of Paystack's { status, message, data } envelope).

export const InitializedTransaction = Schema.Struct({
  authorization_url: Schema.String,
  access_code: Schema.String,
  reference: Schema.String,
});

export const Authorization = Schema.Struct({
  authorization_code: Schema.String,
  last4: Schema.String,
  exp_month: Schema.String,
  exp_year: Schema.String,
  card_type: Schema.String,
  bank: Schema.NullOr(Schema.String),
  brand: Schema.String,
  reusable: Schema.Boolean,
});

export const Transaction = Schema.Struct({
  id: Schema.Number,
  status: Schema.String,
  reference: Schema.String,
  amount: Schema.Number,
  currency: Schema.String,
  paid_at: Schema.NullOr(Schema.String),
  channel: Schema.String,
  authorization: Schema.optionalKey(Authorization),
  customer: Schema.Struct({ id: Schema.Number, email: Schema.String }),
});

export const Refund = Schema.Struct({
  id: Schema.Number,
  amount: Schema.Number,
  currency: Schema.String,
  status: Schema.String,
});

export const Bank = Schema.Struct({
  name: Schema.String,
  code: Schema.String,
  slug: Schema.String,
  active: Schema.Boolean,
  country: Schema.String,
  currency: Schema.String,
  type: Schema.String,
});

export const ResolvedAccount = Schema.Struct({
  account_number: Schema.String,
  account_name: Schema.String,
});

export const TransferRecipient = Schema.Struct({
  recipient_code: Schema.String,
  name: Schema.String,
});

export const Transfer = Schema.Struct({
  amount: Schema.Number,
  currency: Schema.String,
  reference: Schema.String,
  status: Schema.String,
  transfer_code: Schema.String,
});

export const WebhookEvent = Schema.Struct({
  event: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
});

export type WebhookEvent = typeof WebhookEvent.Type;
