import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { Authenticated } from "../../auth/auth.middleware";
import { NotFound } from "../../http/errors";
import { Profile } from "./account.schema";

export class AccountApi extends HttpApiGroup.make("account")
  .add(
    HttpApiEndpoint.get("getMe", "/me", { success: Profile, error: NotFound }).annotate(
      OpenApi.Summary,
      "Get the signed-in user's profile",
    ),
  )
  .middleware(Authenticated)
  .annotate(OpenApi.Description, "The signed-in user's account.") {}
