import type { ObservabilityVariables } from "./logger";
import type { DbVariables } from "./db";
import type { RedisVariables } from "./redis";
import type { S3Variables } from "./s3";

export type AppVariables = ObservabilityVariables & DbVariables & RedisVariables & S3Variables;
