import { AppError } from "../core/errors";

export class SessionExpiredError extends AppError {
  constructor(message = "Your session has expired. Sign in again.") {
    super(401, message, { code: "SESSION_EXPIRED" });
  }
}
