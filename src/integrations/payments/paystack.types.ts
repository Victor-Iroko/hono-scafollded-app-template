export type Currency = "NGN" | "USD" | "GHS" | "ZAR" | "KES" | "XOF";

export type PaymentChannel =
  | "card"
  | "bank"
  | "apple_pay"
  | "ussd"
  | "qr"
  | "mobile_money"
  | "bank_transfer"
  | "eft"
  | "capitec_pay"
  | "payattitude";

export type PaystackMetadata = Record<string, unknown>;

export interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

export interface TransactionRequest {
  amount: number;
  email: string;
  currency?: Currency;
  reference?: string;
  callback_url?: string;
  channels?: PaymentChannel[];
  metadata?: PaystackMetadata;
  bearer?: "account" | "subaccount";
  subaccount?: string;
  plan?: string;
  invoice_limit?: number;
  split_code?: string;
  transaction_charge?: number;
}

export interface TransactionData {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface VerifyTransactionData {
  id: number;
  status: "success" | "failed" | "abandoned" | "ongoing" | "pending" | "processing" | "reversed";
  reference: string;
  amount: number;
  currency: Currency;
  paid_at: string | null;
  channel: string;
  fees: number | null;
  metadata: string | PaystackMetadata | null;
  authorization?: Authorization;
  customer: PaystackCustomer;
  [key: string]: unknown;
}

export interface Authorization {
  authorization_code: string;
  bin: string;
  last4: string;
  exp_month: string;
  exp_year: string;
  channel: string;
  card_type: string;
  bank: string;
  country_code: string;
  brand: string;
  reusable: boolean;
  signature: string;
  account_name: string | null;
}

export interface PaystackCustomer {
  id: number;
  email: string;
  customer_code: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  metadata: PaystackMetadata | null;
  [key: string]: unknown;
}

export interface ChargeAuthorizationRequest {
  authorization_code: string;
  email: string;
  amount: number;
  reference?: string;
  currency?: Currency;
  metadata?: PaystackMetadata;
  channels?: Array<"card" | "bank">;
  queue?: boolean;
}

export interface ChargeAuthorizationData extends Partial<VerifyTransactionData> {
  status: "success" | "failed" | "pending";
  reference: string;
  amount: number;
  currency: Currency;
  paused?: boolean;
  authorization_url?: string;
  access_code?: string;
}

export interface AccountLookupResponseData {
  account_number: string;
  account_name: string;
}

export interface BankData {
  name: string;
  slug: string;
  code: string;
  longcode: string;
  gateway: string | null;
  pay_with_bank: boolean;
  active: boolean;
  country: string;
  currency: string;
  type: string;
  id: number;
}

export interface TransferRecipientRequest {
  type: "nuban" | "mobile_money" | "basa" | "authorization";
  name: string;
  account_number: string;
  bank_code: string;
  currency?: Currency;
  description?: string;
  metadata?: PaystackMetadata;
}

export interface TransferRequest {
  source: "balance";
  amount: number;
  recipient: string;
  reference?: string;
  reason?: string;
  currency?: Currency;
}

export interface BulkTransferRequest {
  source: "balance";
  currency: Currency;
  transfers: Array<{
    amount: number;
    recipient: string;
    reference?: string;
    reason?: string;
  }>;
}

export interface TransferData {
  amount: number;
  currency: Currency;
  reference: string;
  status: "pending" | "success" | "failed" | "otp";
  transfer_code: string;
  [key: string]: unknown;
}

export interface RefundRequest {
  transaction: string;
  amount?: number;
  currency?: Currency;
  customer_note?: string;
  merchant_note?: string;
}

export interface RefundData {
  id: number;
  amount: number;
  currency: Currency;
  status: "pending" | "processed" | "failed";
  refunded_at: string | null;
  transaction: { id: number; reference: string };
}

export interface PaystackWebhookBody {
  event: string;
  data: Record<string, unknown> & {
    reference?: string;
    status?: string;
    amount?: number;
    id?: number;
  };
}

export interface PlanRequest {
  name: string;
  amount: number;
  interval: string;
  description?: string;
  currency?: Currency;
  invoice_limit?: number;
}

export interface SubscriptionRequest {
  customer: string;
  plan: string;
  authorization?: string;
  start_date?: string;
}

export interface SplitRequest {
  name: string;
  type: "percentage" | "flat";
  currency: Currency;
  subaccounts: Array<{ subaccount: string; share: number }>;
  bearer_type?: "account" | "subaccount" | "all";
  bearer_subaccount?: string;
}

export interface SubaccountRequest {
  business_name: string;
  settlement_bank: string;
  account_number: string;
  percentage_charge: number;
  description?: string;
  primary_contact_email?: string;
  primary_contact_name?: string;
  primary_contact_phone?: string;
  metadata?: PaystackMetadata;
}

export type PaystackWebhookEvent = PaystackWebhookBody;
