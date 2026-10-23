import type { AppAuth } from "../auth/auth";
import type { ObservabilityVariables } from "./logger";
import type { DbVariables } from "./db";
import type { RedisVariables } from "./redis";
import type { S3Variables } from "./s3";

export type AuthVariables = {
  auth: AppAuth;
  user: AppAuth["$Infer"]["Session"]["user"] | null;
  session: AppAuth["$Infer"]["Session"]["session"] | null;
};

export type AppVariables = ObservabilityVariables &
  DbVariables &
  RedisVariables &
  S3Variables &
  AuthVariables;
