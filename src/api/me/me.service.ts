import type { AppVariables } from "../../core/context";
import type { CurrentUser } from "./me.schema";

type AuthUser = NonNullable<AppVariables["user"]>;

/** Keeps session material out of the response; only the user is public. */
export function toCurrentUser(user: AuthUser): CurrentUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    image: user.image ?? null,
    createdAt: new Date(user.createdAt).toISOString(),
    updatedAt: new Date(user.updatedAt).toISOString(),
  };
}
