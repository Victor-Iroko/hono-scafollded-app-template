import { checkDbHealth } from "../../core/db";
import { checkEmailHealth } from "../../integrations/email";
import { checkRedisHealth } from "../../core/redis";
import { checkS3Health } from "../../core/s3";

export async function checkReadiness() {
  const [db, redis, s3, email] = await Promise.all([
    checkDbHealth(),
    checkRedisHealth(),
    checkS3Health(),
    checkEmailHealth(),
  ]);

  return {
    ok: db.ok && redis.ok && s3.ok && email.ok,
    db,
    redis,
    s3,
    email,
  };
}
