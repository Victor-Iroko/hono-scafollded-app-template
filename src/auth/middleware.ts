import type { Context, MiddlewareHandler } from "hono";
import type { AppVariables } from "../core/context";
import { UnauthorizedError } from "../core/errors";
import type { AppAuth } from "./auth";

type AuthEnv = { Variables: AppVariables };

async function resolveSession(c: Context<AuthEnv>) {
  const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });

  c.set("user", session?.user ?? null);
  c.set("session", session?.session ?? null);
  return session;
}

/** Makes this request's auth instance available to routes and middleware. */
export function authContext(auth: AppAuth): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    c.set("auth", auth);
    await next();
  };
}

/** Resolves the session when present, but lets anonymous requests continue. */
export const optionalSession: MiddlewareHandler<AuthEnv> = async (c, next) => {
  await resolveSession(c);
  await next();
};

/** Resolves the session and rejects the request when there is none. */
export const requireSession: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const session = await resolveSession(c);
  if (!session) throw new UnauthorizedError("Sign-in required");
  await next();
};

/** Returns the user resolved by `requireSession`; throws if used without it. */
export function getSessionUser(c: Context<AuthEnv>) {
  const user = c.get("user");
  if (!user) throw new UnauthorizedError("No authenticated user in context");
  return user;
}
