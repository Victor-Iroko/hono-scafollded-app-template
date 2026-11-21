import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { user } from "../../db/schema";
import { NotFound } from "../../http/errors";
import { Database } from "../../platform/database";
import type { Profile } from "./account.schema";

export class AccountService extends Context.Service<
  AccountService,
  { readonly getProfile: (userId: string) => Effect.Effect<Profile, NotFound> }
>()("app/AccountService") {
  static readonly layer = Layer.effect(
    AccountService,
    Effect.gen(function* () {
      const db = yield* Database;

      const getProfile = Effect.fn("AccountService.getProfile")(function* (userId: string) {
        const [profile] = yield* db
          .select({
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
            image: user.image,
            createdAt: user.createdAt,
          })
          .from(user)
          .where(eq(user.id, userId))
          .pipe(Effect.orDie);

        if (!profile) return yield* new NotFound({ detail: "Account not found" });
        return profile;
      });

      return AccountService.of({ getProfile });
    }),
  ).pipe(Layer.provide(Database.layer));
}
