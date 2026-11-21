import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { CurrentUser } from "../../auth/auth.middleware";
import { Api } from "../../http/api";
import { AccountService } from "./account.service";

export const AccountHandlersNoDeps = HttpApiBuilder.group(
  Api,
  "account",
  Effect.fn(function* (handlers) {
    const account = yield* AccountService;

    return handlers.handle("getMe", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        return yield* account.getProfile(user.id);
      }),
    );
  }),
);

export const AccountHandlers = AccountHandlersNoDeps.pipe(Layer.provide(AccountService.layer));
