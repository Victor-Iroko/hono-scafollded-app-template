// Paystack REST client on Effect's HttpClient.
//
// Every call has a timeout and a span, unwraps Paystack's { status, message,
// data } envelope, and decodes `data` with a schema. Reads retry transient
// failures; calls that move money never retry automatically. They carry a
// caller-chosen `reference`, so after a Network error verify by reference
// before trying again. Use `request` for endpoints without a helper here.
import { Duration, Effect, Layer, Redacted, Schedule, Schema, Context } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { PaystackConfig } from "../../config";
import { PaystackError } from "./paystack.error";
import {
  Bank,
  InitializedTransaction,
  Refund,
  ResolvedAccount,
  Transaction,
  Transfer,
  TransferRecipient,
  type ChargeAuthorization,
  type CreateRefund,
  type CreateTransferRecipient,
  type InitializeTransaction,
  type InitiateTransfer,
} from "./paystack.schema";

type DataSchema = Schema.Top & { readonly DecodingServices: never };

export interface PaystackRequest<S extends DataSchema> {
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly data: S;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
}

const READ_RETRY = Schedule.exponential(Duration.millis(200)).pipe(Schedule.jittered);
const READ_RETRY_TIMES = 3;

const Envelope = Schema.Struct({
  status: Schema.Boolean,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
});

const definedParams = (query: PaystackRequest<DataSchema>["query"] = {}) =>
  Object.fromEntries(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );

export class PaystackClient extends Context.Service<
  PaystackClient,
  {
    readonly request: <S extends DataSchema>(
      request: PaystackRequest<S>,
    ) => Effect.Effect<S["Type"], PaystackError>;
    readonly initializeTransaction: (
      body: InitializeTransaction,
    ) => Effect.Effect<typeof InitializedTransaction.Type, PaystackError>;
    readonly verifyTransaction: (
      reference: string,
    ) => Effect.Effect<typeof Transaction.Type, PaystackError>;
    readonly chargeAuthorization: (
      body: ChargeAuthorization,
    ) => Effect.Effect<typeof Transaction.Type, PaystackError>;
    readonly refundTransaction: (
      body: CreateRefund,
    ) => Effect.Effect<typeof Refund.Type, PaystackError>;
    readonly listBanks: (query?: {
      readonly country?: string;
      readonly currency?: string;
    }) => Effect.Effect<ReadonlyArray<typeof Bank.Type>, PaystackError>;
    readonly resolveAccount: (
      accountNumber: string,
      bankCode: string,
    ) => Effect.Effect<typeof ResolvedAccount.Type, PaystackError>;
    readonly createTransferRecipient: (
      body: CreateTransferRecipient,
    ) => Effect.Effect<typeof TransferRecipient.Type, PaystackError>;
    readonly initiateTransfer: (
      body: InitiateTransfer,
    ) => Effect.Effect<typeof Transfer.Type, PaystackError>;
    readonly verifyTransfer: (
      reference: string,
    ) => Effect.Effect<typeof Transfer.Type, PaystackError>;
  }
>()("app/PaystackClient") {
  static readonly layerNoDeps = Layer.effect(
    PaystackClient,
    Effect.gen(function* () {
      const config = yield* PaystackConfig;
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.prependUrl(config.baseUrl),
            HttpClientRequest.bearerToken(Redacted.value(config.secretKey)),
            HttpClientRequest.acceptJson,
          ),
        ),
      );
      const timeout = Duration.millis(config.requestTimeoutMs);

      const request = <S extends DataSchema>(options: PaystackRequest<S>) => {
        const base = HttpClientRequest.make(options.method)(options.path).pipe(
          HttpClientRequest.setUrlParams(definedParams(options.query)),
        );
        const outgoing =
          options.body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, options.body);

        const send = http.execute(outgoing).pipe(
          Effect.timeout(timeout),
          Effect.mapError(
            (cause) =>
              new PaystackError({ reason: "Network", message: "Paystack request failed", cause }),
          ),
        );
        // Reads are safe to repeat; anything that can move money is not.
        const sendWithRetry =
          options.method === "GET"
            ? send.pipe(
                Effect.retry({
                  schedule: READ_RETRY,
                  times: READ_RETRY_TIMES,
                  while: (error) => error.reason === "Network",
                }),
              )
            : send;

        return sendWithRetry.pipe(
          Effect.flatMap((response) =>
            HttpClientResponse.schemaBodyJson(Envelope)(response).pipe(
              Effect.mapError(
                (cause) =>
                  new PaystackError({
                    reason: "Decode",
                    message: `Unreadable Paystack response (HTTP ${response.status})`,
                    status: response.status,
                    cause,
                  }),
              ),
              Effect.flatMap((envelope) =>
                response.status >= 400 || !envelope.status
                  ? Effect.fail(
                      new PaystackError({
                        reason: "Api",
                        message: envelope.message,
                        status: response.status,
                      }),
                    )
                  : Schema.decodeUnknownEffect(options.data)(envelope.data).pipe(
                      Effect.mapError(
                        (cause) =>
                          new PaystackError({
                            reason: "Decode",
                            message: "Unexpected Paystack response data",
                            status: response.status,
                            cause,
                          }),
                      ),
                    ),
              ),
            ),
          ),
          Effect.withSpan("Paystack.request", {
            attributes: { "http.request.method": options.method, "paystack.path": options.path },
          }),
        );
      };

      const encode = encodeURIComponent;

      return PaystackClient.of({
        request,
        initializeTransaction: (body) =>
          request({
            method: "POST",
            path: "/transaction/initialize",
            body,
            data: InitializedTransaction,
          }),
        verifyTransaction: (reference) =>
          request({
            method: "GET",
            path: `/transaction/verify/${encode(reference)}`,
            data: Transaction,
          }),
        chargeAuthorization: (body) =>
          request({
            method: "POST",
            path: "/transaction/charge_authorization",
            body,
            data: Transaction,
          }),
        refundTransaction: (body) =>
          request({ method: "POST", path: "/refund", body, data: Refund }),
        listBanks: (query = {}) =>
          request({ method: "GET", path: "/bank", query, data: Schema.Array(Bank) }),
        resolveAccount: (accountNumber, bankCode) =>
          request({
            method: "GET",
            path: "/bank/resolve",
            query: { account_number: accountNumber, bank_code: bankCode },
            data: ResolvedAccount,
          }),
        createTransferRecipient: (body) =>
          request({ method: "POST", path: "/transferrecipient", body, data: TransferRecipient }),
        initiateTransfer: (body) =>
          request({ method: "POST", path: "/transfer", body, data: Transfer }),
        verifyTransfer: (reference) =>
          request({ method: "GET", path: `/transfer/verify/${encode(reference)}`, data: Transfer }),
      });
    }),
  );

  static readonly layer = this.layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer));
}
