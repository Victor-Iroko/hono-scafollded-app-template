import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Counter, Histogram } from "prom-client";
import { createMiddleware } from "hono/factory";
import type {
  BucketLocationConstraint,
  PutObjectCommandInput,
  S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getEnv } from "./env";
import { getLogger } from "./logger";
import { getMetricsRegistry } from "./metrics";

export type S3Variables = { s3: S3Client };

export type PutObjectBody = NonNullable<PutObjectCommandInput["Body"]>;

let opsCounter: Counter | undefined;
let durationHistogram: Histogram | undefined;

function s3Metrics(): { opsCounter: Counter; durationHistogram: Histogram } {
  if (!opsCounter || !durationHistogram) {
    const registry = getMetricsRegistry();
    opsCounter = new Counter({
      name: "s3_operations_total",
      help: "S3 operations by command and outcome",
      labelNames: ["operation", "status"],
      registers: [registry],
    });
    durationHistogram = new Histogram({
      name: "s3_operation_duration_seconds",
      help: "S3 operation latency in seconds",
      labelNames: ["operation"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    });
  }
  return { opsCounter, durationHistogram };
}

// Direct getS3().send() calls skip this; prefer the helpers below.
async function track<T>(operation: string, run: () => Promise<T>): Promise<T> {
  const { opsCounter: ops, durationHistogram: duration } = s3Metrics();
  const end = duration.startTimer({ operation });
  try {
    const result = await run();
    end();
    ops.inc({ operation, status: "success" });
    return result;
  } catch (err) {
    end();
    ops.inc({ operation, status: "error" });
    throw err;
  }
}

// Cache on globalThis so `bun --hot` reloads don't leak clients.
const globalCache = globalThis as unknown as {
  __s3?: S3Client;
  __s3Presign?: S3Client;
};

function clientConfig(): S3ClientConfig {
  const env = getEnv();
  return {
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    // Non-AWS implementations (RustFS, MinIO, S3Mock) reject the flexible
    // checksum headers the SDK has sent by default since v3.729.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials:
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  };
}

export function getS3(): S3Client {
  if (globalCache.__s3) return globalCache.__s3;
  const env = getEnv();
  const client = new S3Client({ ...clientConfig(), endpoint: env.S3_ENDPOINT });
  globalCache.__s3 = client;
  return client;
}

// Presigned URLs are signed against the host they will be used from. Inside
// Docker that is not the internal service name, so S3_PUBLIC_ENDPOINT signs a
// URL a browser can actually reach. Without it, sign with the normal client.
function getPresignClient(): S3Client {
  const env = getEnv();
  if (!env.S3_PUBLIC_ENDPOINT) return getS3();
  if (!globalCache.__s3Presign) {
    globalCache.__s3Presign = new S3Client({
      ...clientConfig(),
      endpoint: env.S3_PUBLIC_ENDPOINT,
    });
  }
  return globalCache.__s3Presign;
}

export function s3Middleware() {
  void getS3();
  return createMiddleware<{ Variables: S3Variables }>(async (c, next) => {
    c.set("s3", getS3());
    await next();
  });
}

export type PutObjectOptions = {
  contentType?: string;
  contentDisposition?: string;
  cacheControl?: string;
};

export async function putObject(
  key: string,
  body: PutObjectBody,
  options: PutObjectOptions = {},
): Promise<void> {
  await track("PutObject", () =>
    getS3().send(
      new PutObjectCommand({
        Bucket: getEnv().S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentDisposition: options.contentDisposition,
        CacheControl: options.cacheControl,
      }),
    ),
  );
}

export async function deleteObject(key: string): Promise<void> {
  await track("DeleteObject", () =>
    getS3().send(new DeleteObjectCommand({ Bucket: getEnv().S3_BUCKET, Key: key })),
  );
}

export type PresignOptions = {
  /** Seconds until the URL expires. Defaults to S3_PRESIGN_EXPIRES_S. */
  expiresIn?: number;
  contentType?: string;
  contentDisposition?: string;
};

function resolveExpiry(expiresIn?: number): number {
  return expiresIn ?? getEnv().S3_PRESIGN_EXPIRES_S;
}

/** Presigned PUT so clients upload straight to storage, bypassing the API. */
export async function presignUpload(key: string, options: PresignOptions = {}): Promise<string> {
  return getSignedUrl(
    getPresignClient(),
    new PutObjectCommand({
      Bucket: getEnv().S3_BUCKET,
      Key: key,
      ContentType: options.contentType,
    }),
    { expiresIn: resolveExpiry(options.expiresIn) },
  );
}

/** Presigned GET for private objects. */
export async function presignDownload(key: string, options: PresignOptions = {}): Promise<string> {
  return getSignedUrl(
    getPresignClient(),
    new GetObjectCommand({
      Bucket: getEnv().S3_BUCKET,
      Key: key,
      ResponseContentType: options.contentType,
      ResponseContentDisposition: options.contentDisposition,
    }),
    { expiresIn: resolveExpiry(options.expiresIn) },
  );
}

/** A missing bucket is a 404; every other failure is worth a look. */
function isBucketNotFound(err: unknown): boolean {
  const failure = err as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return failure?.name === "NotFound" || failure?.$metadata?.httpStatusCode === 404;
}

/**
 * Idempotently create the configured bucket. Intended for local stacks;
 * production buckets belong to IaC.
 */
export async function ensureBucket(): Promise<void> {
  const env = getEnv();
  const client = getS3();
  try {
    await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    return;
  } catch (err) {
    // Missing buckets are expected locally; log other failures for diagnosis.
    if (isBucketNotFound(err)) {
      getLogger().debug({ bucket: env.S3_BUCKET }, "s3 bucket missing, creating it");
    } else {
      getLogger().warn(
        { err, bucket: env.S3_BUCKET, endpoint: env.S3_ENDPOINT },
        "s3 head bucket failed, attempting to create it anyway",
      );
    }
  }

  try {
    await client.send(
      new CreateBucketCommand({
        Bucket: env.S3_BUCKET,
        CreateBucketConfiguration:
          env.S3_REGION === "us-east-1"
            ? undefined
            : { LocationConstraint: env.S3_REGION as BucketLocationConstraint },
      }),
    );
    getLogger().info({ bucket: env.S3_BUCKET }, "s3 bucket created");
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "BucketAlreadyExists" || name === "BucketAlreadyOwnedByYou") {
      getLogger().debug({ bucket: env.S3_BUCKET }, "s3 bucket already exists");
      return;
    }
    throw err;
  }
}

export async function checkS3Health(
  timeoutMs = 2_000,
): Promise<{ ok: boolean; latencyMs: number }> {
  const start = performance.now();
  try {
    await Promise.race([
      getS3().send(new HeadBucketCommand({ Bucket: getEnv().S3_BUCKET })),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("s3 health timeout")), timeoutMs),
      ),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    getLogger().warn({ err }, "s3 health check failed");
    return { ok: false, latencyMs: Math.round(performance.now() - start) };
  }
}

export async function closeS3(): Promise<void> {
  const { __s3, __s3Presign } = globalCache;
  globalCache.__s3 = undefined;
  globalCache.__s3Presign = undefined;
  __s3?.destroy();
  __s3Presign?.destroy();
}
