import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "../../core/env";
import type {
  AccountLookupResponseData,
  BankData,
  BulkTransferRequest,
  ChargeAuthorizationData,
  ChargeAuthorizationRequest,
  Currency,
  PaystackResponse,
  PaystackWebhookBody,
  PlanRequest,
  RefundData,
  RefundRequest,
  SplitRequest,
  SubaccountRequest,
  SubscriptionRequest,
  TransactionData,
  TransactionRequest,
  TransferData,
  TransferRecipientRequest,
  TransferRequest,
  VerifyTransactionData,
} from "./paystack.types";

const BASE_URL = "https://api.paystack.co";
const REQUEST_TIMEOUT_MS = 15_000;

export class PaystackError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PaystackError";
  }
}

async function paystackFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<PaystackResponse<T>> {
  const secretKey = getEnv().PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    throw new PaystackError("PAYSTACK_SECRET_KEY is required to use the Paystack integration");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${secretKey}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new PaystackError("Paystack request failed", undefined, { cause });
  }

  const result = (await response.json().catch(() => null)) as PaystackResponse<T> | null;
  if (!response.ok || !result?.status) {
    throw new PaystackError(
      result?.message || `Paystack request failed with HTTP ${response.status}`,
      response.status,
    );
  }

  return result;
}

function jsonBody(body: unknown): string {
  return JSON.stringify(body);
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

// Transactions

export function initializeTransaction(
  body: TransactionRequest,
): Promise<PaystackResponse<TransactionData>> {
  return paystackFetch("/transaction/initialize", { method: "POST", body: jsonBody(body) });
}

export function verifyTransaction(
  reference: string,
): Promise<PaystackResponse<VerifyTransactionData>> {
  return paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
}

export function chargeAuthorization(
  body: ChargeAuthorizationRequest,
): Promise<PaystackResponse<ChargeAuthorizationData>> {
  return paystackFetch("/transaction/charge_authorization", {
    method: "POST",
    body: jsonBody(body),
  });
}

export function listTransactions(
  params: {
    perPage?: number;
    page?: number;
    customer?: number;
    status?: "failed" | "success" | "abandoned";
    from?: string;
    to?: string;
    currency?: Currency;
  } = {},
): Promise<PaystackResponse<Record<string, unknown>[]>> {
  return paystackFetch(
    `/transaction${queryString({
      perPage: params.perPage,
      page: params.page,
      customer: params.customer,
      status: params.status,
      from: params.from,
      to: params.to,
      currency: params.currency,
    })}`,
  );
}

export function fetchTransaction(
  id: number | string,
): Promise<PaystackResponse<VerifyTransactionData>> {
  return paystackFetch(`/transaction/${encodeURIComponent(String(id))}`);
}

export function transactionTimeline(
  idOrReference: number | string,
): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch(`/transaction/timeline/${encodeURIComponent(String(idOrReference))}`);
}

export function transactionTotals(): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch("/transaction/totals");
}

// Cards and recurring authorization

export function initializeAuthorization(body: {
  email: string;
  channel?: "card" | "direct_debit";
  callback_url?: string;
}): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch("/customer/authorization/initialize", {
    method: "POST",
    body: jsonBody(body),
  });
}

export function verifyAuthorization(body: {
  reference: string;
  authorization_code: string;
}): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch("/customer/authorization/verify", {
    method: "POST",
    body: jsonBody(body),
  });
}

export function deactivateAuthorization(body: {
  authorization_code: string;
  email: string;
}): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch("/customer/authorization/deactivate", {
    method: "POST",
    body: jsonBody(body),
  });
}

// Plans and subscriptions

export function createPlan(body: PlanRequest): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch("/plan", { method: "POST", body: jsonBody(body) });
}

export function listPlans(
  params: {
    perPage?: number;
    page?: number;
    status?: boolean;
    interval?: string;
  } = {},
): Promise<PaystackResponse<Record<string, unknown>[]>> {
  return paystackFetch(
    `/plan${queryString({
      perPage: params.perPage,
      page: params.page,
      status: params.status,
      interval: params.interval,
    })}`,
  );
}

export function fetchPlan(idOrCode: string): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch(`/plan/${encodeURIComponent(idOrCode)}`);
}

export function updatePlan(
  idOrCode: string,
  body: Partial<PlanRequest>,
): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch(`/plan/${encodeURIComponent(idOrCode)}`, {
    method: "PUT",
    body: jsonBody(body),
  });
}

export function createSubscription(
  body: SubscriptionRequest,
): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch("/subscription", { method: "POST", body: jsonBody(body) });
}

export function listSubscriptions(
  params: {
    perPage?: number;
    page?: number;
    customer?: string;
    plan?: string;
  } = {},
): Promise<PaystackResponse<Record<string, unknown>[]>> {
  return paystackFetch(`/subscription${queryString(params)}`);
}

export function fetchSubscription(
  idOrCode: string,
): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch(`/subscription/${encodeURIComponent(idOrCode)}`);
}

export function enableSubscription(body: {
  code: string;
  token: string;
}): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch("/subscription/enable", {
    method: "POST",
    body: jsonBody(body),
  });
}

export function disableSubscription(body: {
  code: string;
  token: string;
}): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch("/subscription/disable", {
    method: "POST",
    body: jsonBody(body),
  });
}

// Refunds

export function refundTransaction(body: RefundRequest): Promise<PaystackResponse<RefundData>> {
  return paystackFetch("/refund", { method: "POST", body: jsonBody(body) });
}

export function listRefunds(
  params: {
    perPage?: number;
    page?: number;
    reference?: string;
    currency?: Currency;
  } = {},
): Promise<PaystackResponse<RefundData[]>> {
  return paystackFetch(`/refund${queryString(params)}`);
}

export function fetchRefund(id: number | string): Promise<PaystackResponse<RefundData>> {
  return paystackFetch(`/refund/${encodeURIComponent(String(id))}`);
}

// Bank account verification

export function accountLookup(
  bankCode: string,
  accountNumber: string,
): Promise<PaystackResponse<AccountLookupResponseData>> {
  return paystackFetch(
    `/bank/resolve${queryString({ bank_code: bankCode, account_number: accountNumber })}`,
  );
}

export function listBanks(
  params: {
    country?: string;
    currency?: Currency;
    type?: string;
    payWithBank?: boolean;
  } = {},
): Promise<PaystackResponse<BankData[]>> {
  return paystackFetch(
    `/bank${queryString({
      country: params.country,
      currency: params.currency,
      type: params.type,
      pay_with_bank: params.payWithBank,
    })}`,
  );
}

export function resolveCardBin(bin: string): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch(`/decision/bin/${encodeURIComponent(bin)}`);
}

// Transfers and recipients

export function createTransferRecipient(
  body: TransferRecipientRequest,
): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch("/transferrecipient", { method: "POST", body: jsonBody(body) });
}

export function listTransferRecipients(
  params: {
    perPage?: number;
    page?: number;
    type?: string;
  } = {},
): Promise<PaystackResponse<Record<string, unknown>[]>> {
  return paystackFetch(`/transferrecipient${queryString(params)}`);
}

export function fetchTransferRecipient(
  idOrCode: number | string,
): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch(`/transferrecipient/${encodeURIComponent(String(idOrCode))}`);
}

export function initiateTransfer(body: TransferRequest): Promise<PaystackResponse<TransferData>> {
  return paystackFetch("/transfer", { method: "POST", body: jsonBody(body) });
}

export function initiateBulkTransfer(
  body: BulkTransferRequest,
): Promise<PaystackResponse<TransferData[]>> {
  return paystackFetch("/transfer/bulk", { method: "POST", body: jsonBody(body) });
}

export function finalizeTransfer(body: {
  transfer_code: string;
  otp: string;
}): Promise<PaystackResponse<TransferData>> {
  return paystackFetch("/transfer/finalize_transfer", {
    method: "POST",
    body: jsonBody(body),
  });
}

export function verifyTransfer(reference: string): Promise<PaystackResponse<TransferData>> {
  return paystackFetch(`/transfer/verify/${encodeURIComponent(reference)}`);
}

export function listTransfers(
  params: {
    perPage?: number;
    page?: number;
    customer?: number;
    status?: string;
  } = {},
): Promise<PaystackResponse<TransferData[]>> {
  return paystackFetch(`/transfer${queryString(params)}`);
}

export function checkBalance(): Promise<PaystackResponse<Record<string, unknown>[]>> {
  return paystackFetch("/balance");
}

// Splits and subaccounts

export function createSubaccount(
  body: SubaccountRequest,
): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch("/subaccount", { method: "POST", body: jsonBody(body) });
}

export function listSubaccounts(
  params: {
    perPage?: number;
    page?: number;
  } = {},
): Promise<PaystackResponse<Record<string, unknown>[]>> {
  return paystackFetch(`/subaccount${queryString(params)}`);
}

export function fetchSubaccount(
  idOrCode: number | string,
): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch(`/subaccount/${encodeURIComponent(String(idOrCode))}`);
}

export function updateSubaccount(
  idOrCode: number | string,
  body: Partial<SubaccountRequest>,
): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch(`/subaccount/${encodeURIComponent(String(idOrCode))}`, {
    method: "PUT",
    body: jsonBody(body),
  });
}

export function createSplit(
  body: SplitRequest,
): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch("/split", { method: "POST", body: jsonBody(body) });
}

export function listSplits(
  params: {
    perPage?: number;
    page?: number;
  } = {},
): Promise<PaystackResponse<Record<string, unknown>[]>> {
  return paystackFetch(`/split${queryString(params)}`);
}

export function fetchSplit(
  idOrCode: number | string,
): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch(`/split/${encodeURIComponent(String(idOrCode))}`);
}

export function updateSplit(
  idOrCode: number | string,
  body: Partial<SplitRequest>,
): Promise<PaystackResponse<Record<string, unknown>>> {
  return paystackFetch(`/split/${encodeURIComponent(String(idOrCode))}`, {
    method: "PUT",
    body: jsonBody(body),
  });
}

export function addSubaccountToSplit(
  body: {
    subaccount: string;
    share: number;
  } & ({ split_code: string } | { id: number }),
): Promise<PaystackResponse<Record<string, unknown>>> {
  const splitId = "split_code" in body ? body.split_code : body.id;
  const subaccount = { subaccount: body.subaccount, share: body.share };
  return paystackFetch(`/split/${encodeURIComponent(String(splitId))}/subaccount/add`, {
    method: "POST",
    body: jsonBody(subaccount),
  });
}

export function removeSubaccountFromSplit(
  body: {
    subaccount: string;
  } & ({ split_code: string } | { id: number }),
): Promise<PaystackResponse<Record<string, unknown>>> {
  const splitId = "split_code" in body ? body.split_code : body.id;
  const subaccount = { subaccount: body.subaccount };
  return paystackFetch(`/split/${encodeURIComponent(String(splitId))}/subaccount/remove`, {
    method: "POST",
    body: jsonBody(subaccount),
  });
}

// Paystack signs the exact raw request body using HMAC-SHA512.
export function verifyWebhookSignature(
  rawBody: string | ArrayBuffer | Uint8Array,
  signature: string | undefined,
): boolean {
  if (!signature || !/^[a-f\d]{128}$/i.test(signature)) return false;
  const secretKey = getEnv().PAYSTACK_SECRET_KEY;
  if (!secretKey) return false;

  const body = typeof rawBody === "string" ? rawBody : Buffer.from(new Uint8Array(rawBody));
  const expected = createHmac("sha512", secretKey).update(body).digest();
  const received = Buffer.from(signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function parseWebhookBody(rawBody: string | ArrayBuffer | Uint8Array): PaystackWebhookBody {
  const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("event" in parsed) ||
    typeof parsed.event !== "string" ||
    !("data" in parsed) ||
    typeof parsed.data !== "object" ||
    parsed.data === null
  ) {
    throw new PaystackError("Invalid Paystack webhook payload");
  }
  return parsed as PaystackWebhookBody;
}
