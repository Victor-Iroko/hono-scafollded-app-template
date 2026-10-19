import { createTransport } from "nodemailer";
import type { Transporter } from "nodemailer";
import { getEnv } from "../../core/env";
import { getLogger } from "../../core/logger";

// Cache on globalThis so `bun --hot` reloads don't leak connections.
const globalCache = globalThis as unknown as { __smtp?: Transporter };

/** Add credentials to SMTP_URL so nodemailer handles parsing and encoding. */
function connectionUrl(): string {
  const env = getEnv();
  if (!env.SMTP_USER) return env.SMTP_URL;
  const url = new URL(env.SMTP_URL);
  url.username = env.SMTP_USER;
  url.password = env.SMTP_PASSWORD ?? "";
  return url.toString();
}

export function getSmtpTransport(): Transporter {
  return (globalCache.__smtp ??= createTransport(connectionUrl()));
}

export async function checkEmailHealth(
  timeoutMs = 2_000,
): Promise<{ ok: boolean; latencyMs: number }> {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  try {
    await Promise.race([
      getSmtpTransport().verify(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("smtp health timeout")), timeoutMs),
      ),
    ]);
    return { ok: true, latencyMs: elapsed() };
  } catch (err) {
    getLogger().warn({ err }, "smtp health check failed");
    return { ok: false, latencyMs: elapsed() };
  }
}

export function closeSmtp(): void {
  globalCache.__smtp?.close();
  globalCache.__smtp = undefined;
}
