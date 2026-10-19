import { Counter, Histogram } from "prom-client";
import { getEnv } from "../../core/env";
import { getMetricsRegistry } from "../../core/metrics";
import { getSmtpTransport } from "./smtp";

export type OutboundEmail = {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

let sentCounter: Counter | undefined;
let durationHistogram: Histogram | undefined;

function emailMetrics(): { sentCounter: Counter; durationHistogram: Histogram } {
  if (!sentCounter || !durationHistogram) {
    const registry = getMetricsRegistry();
    sentCounter = new Counter({
      name: "email_sent_total",
      help: "Emails handed to the relay by outcome",
      labelNames: ["status"],
      registers: [registry],
    });
    durationHistogram = new Histogram({
      name: "email_send_duration_seconds",
      help: "Email send latency in seconds",
      labelNames: [],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    });
  }
  return { sentCounter, durationHistogram };
}

/** Isolates email delivery so SMTP can be replaced without changing callers. */
export async function sendEmail(message: OutboundEmail): Promise<{ messageId: string }> {
  const env = getEnv();
  const { sentCounter: sent, durationHistogram: duration } = emailMetrics();
  const end = duration.startTimer();

  try {
    const info = await getSmtpTransport().sendMail({
      from: env.EMAIL_FROM,
      to: message.to,
      replyTo: message.replyTo ?? env.EMAIL_REPLY_TO,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    end();
    sent.inc({ status: "success" });
    return { messageId: info.messageId };
  } catch (err) {
    end();
    sent.inc({ status: "error" });
    throw err;
  }
}
