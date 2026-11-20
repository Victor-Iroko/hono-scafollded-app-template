// S3-compatible object storage (AWS S3, RustFS, MinIO, R2, ...) through the
// AWS SDK. Every call gets a timeout and a span, and fails with StorageError.
//
// Clients upload and download directly with presigned URLs, so file bodies
// never pass through the API. Never build keys from client-supplied file names.
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type BucketLocationConstraint,
  type PutObjectCommandInput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Cause, Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { StorageConfig } from "../config";

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export type ObjectBody = NonNullable<PutObjectCommandInput["Body"]>;

export interface PutOptions {
  readonly contentType?: string;
  readonly contentDisposition?: string;
  readonly cacheControl?: string;
}

export interface PresignOptions {
  /** Seconds until the URL expires. Defaults to S3_PRESIGN_EXPIRES_S. */
  readonly expiresInS?: number;
  readonly contentType?: string;
  readonly contentDisposition?: string;
}

const isMissingBucket = (error: unknown) => {
  const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return failure?.name === "NotFound" || failure?.$metadata?.httpStatusCode === 404;
};

const isAlreadyCreated = (error: unknown) => {
  const name = (error as { name?: string } | null)?.name;
  return name === "BucketAlreadyExists" || name === "BucketAlreadyOwnedByYou";
};

export class Storage extends Context.Service<
  Storage,
  {
    readonly put: (
      key: string,
      body: ObjectBody,
      options?: PutOptions,
    ) => Effect.Effect<void, StorageError>;
    readonly remove: (key: string) => Effect.Effect<void, StorageError>;
    /** Presigned PUT so clients upload straight to storage. */
    readonly presignUpload: (
      key: string,
      options?: PresignOptions,
    ) => Effect.Effect<string, StorageError>;
    /** Presigned GET for private objects. */
    readonly presignDownload: (
      key: string,
      options?: PresignOptions,
    ) => Effect.Effect<string, StorageError>;
    /** Confirms the bucket exists and is reachable. */
    readonly check: Effect.Effect<void, StorageError>;
  }
>()("app/Storage") {
  static readonly layer = Layer.effect(
    Storage,
    Effect.gen(function* () {
      const config = yield* StorageConfig;
      if (Option.isSome(config.accessKeyId) !== Option.isSome(config.secretAccessKey)) {
        return yield* Effect.fail(
          new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together"),
        );
      }

      const clientConfig: S3ClientConfig = {
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        // Non-AWS implementations reject the checksum headers the SDK sends by default.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        ...(Option.isSome(config.accessKeyId) && Option.isSome(config.secretAccessKey)
          ? {
              credentials: {
                accessKeyId: config.accessKeyId.value,
                secretAccessKey: Redacted.value(config.secretAccessKey.value),
              },
            }
          : {}),
      };
      const makeClient = (endpoint: Option.Option<URL>) =>
        Effect.acquireRelease(
          Effect.sync(
            () =>
              new S3Client({
                ...clientConfig,
                ...(Option.isSome(endpoint) ? { endpoint: endpoint.value.toString() } : {}),
              }),
          ),
          (client) => Effect.sync(() => client.destroy()),
        );

      const client = yield* makeClient(config.endpoint);
      // Presigned URLs are signed for the host they are used from; inside Docker
      // that is not the internal service name.
      const presignClient = Option.isSome(config.publicEndpoint)
        ? yield* makeClient(config.publicEndpoint)
        : client;

      const timeout = Duration.millis(config.requestTimeoutMs);
      const call = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) => new StorageError({ operation, cause }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new StorageError({ operation, cause: new Error(`${operation} timed out`) }),
              ),
          }),
          Effect.withSpan(`Storage.${operation}`, {
            attributes: { "storage.bucket": config.bucket },
          }),
        );
      const Bucket = config.bucket;
      const expiresIn = (options?: PresignOptions) => options?.expiresInS ?? config.presignExpiresS;

      const put = (key: string, body: ObjectBody, options: PutOptions = {}) =>
        call("put", (abortSignal) =>
          client.send(
            new PutObjectCommand({
              Bucket,
              Key: key,
              Body: body,
              ContentType: options.contentType,
              ContentDisposition: options.contentDisposition,
              CacheControl: options.cacheControl,
            }),
            { abortSignal },
          ),
        ).pipe(Effect.asVoid);

      const remove = (key: string) =>
        call("remove", (abortSignal) =>
          client.send(new DeleteObjectCommand({ Bucket, Key: key }), { abortSignal }),
        ).pipe(Effect.asVoid);

      const presignUpload = (key: string, options?: PresignOptions) =>
        call("presignUpload", () =>
          getSignedUrl(
            presignClient,
            new PutObjectCommand({ Bucket, Key: key, ContentType: options?.contentType }),
            { expiresIn: expiresIn(options) },
          ),
        );

      const presignDownload = (key: string, options?: PresignOptions) =>
        call("presignDownload", () =>
          getSignedUrl(
            presignClient,
            new GetObjectCommand({
              Bucket,
              Key: key,
              ResponseContentType: options?.contentType,
              ResponseContentDisposition: options?.contentDisposition,
            }),
            { expiresIn: expiresIn(options) },
          ),
        );

      const check = call("check", (abortSignal) =>
        client.send(new HeadBucketCommand({ Bucket }), { abortSignal }),
      ).pipe(Effect.asVoid);

      const ensureBucket = Effect.gen(function* () {
        const head = yield* Effect.exit(check);
        if (head._tag === "Success") return;
        const error = Cause.squash(head.cause);
        if (!(error instanceof StorageError && isMissingBucket(error.cause))) {
          yield* Effect.logWarning("storage bucket check failed; trying to create it");
        }
        yield* call("createBucket", (abortSignal) =>
          client.send(
            new CreateBucketCommand({
              Bucket,
              CreateBucketConfiguration:
                config.region === "us-east-1"
                  ? undefined
                  : { LocationConstraint: config.region as BucketLocationConstraint },
            }),
            { abortSignal },
          ),
        ).pipe(
          Effect.catchTag("StorageError", (error) =>
            isAlreadyCreated(error.cause) ? Effect.void : Effect.fail(error),
          ),
        );
        yield* Effect.logInfo("storage bucket created").pipe(
          Effect.annotateLogs({ bucket: Bucket }),
        );
      });

      // A missing bucket must not stop the API from booting; /readyz reports it.
      if (config.autoCreateBucket) {
        yield* ensureBucket.pipe(
          Effect.catchTag("StorageError", (error) =>
            Effect.logWarning("storage bucket bootstrap failed").pipe(
              Effect.annotateLogs({ cause: error.cause }),
            ),
          ),
        );
      }

      return Storage.of({ put, remove, presignUpload, presignDownload, check });
    }),
  );
}
