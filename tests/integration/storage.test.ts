// Requires S3Mock from docker-compose.test.yml (bucket app-bucket-test).
import { afterAll, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Storage } from "../../src/platform/storage";
import { withTestConfig } from "../support/config";

const runtime = ManagedRuntime.make(Storage.layer.pipe(withTestConfig()));
const missingBucket = ManagedRuntime.make(
  Storage.layer.pipe(withTestConfig({ S3_BUCKET: "bucket-that-does-not-exist" })),
);

afterAll(async () => {
  await Promise.all([runtime.dispose(), missingBucket.dispose()]);
});

const withStorage = <A, E>(f: (storage: Storage["Service"]) => Effect.Effect<A, E>) =>
  runtime.runPromise(Effect.flatMap(Effect.service(Storage), f));

describe("Storage", () => {
  test("puts an object and serves it through a presigned download URL", async () => {
    const key = `tests/${crypto.randomUUID()}.txt`;
    await withStorage((storage) =>
      storage.put(key, "hello storage", { contentType: "text/plain" }),
    );

    const url = await withStorage((storage) => storage.presignDownload(key));
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello storage");
  });

  test("accepts a direct upload through a presigned upload URL", async () => {
    const key = `tests/${crypto.randomUUID()}.txt`;
    const uploadUrl = await withStorage((storage) =>
      storage.presignUpload(key, { contentType: "text/plain" }),
    );

    const upload = await fetch(uploadUrl, {
      method: "PUT",
      body: "uploaded directly",
      headers: { "content-type": "text/plain" },
    });
    expect(upload.status).toBe(200);

    const download = await fetch(await withStorage((storage) => storage.presignDownload(key)));
    expect(await download.text()).toBe("uploaded directly");
  });

  test("removes an object", async () => {
    const key = `tests/${crypto.randomUUID()}.txt`;
    await withStorage((storage) => storage.put(key, "temporary"));
    await withStorage((storage) => storage.remove(key));

    const response = await fetch(await withStorage((storage) => storage.presignDownload(key)));
    expect(response.status).toBe(404);
  });

  test("check passes for the configured bucket and fails for a missing one", async () => {
    await withStorage((storage) => storage.check);

    const exit = await missingBucket.runPromise(
      Effect.exit(Effect.flatMap(Effect.service(Storage), (storage) => storage.check)),
    );
    expect(exit._tag).toBe("Failure");
  });
});
