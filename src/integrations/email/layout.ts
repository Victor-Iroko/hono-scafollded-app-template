// Shared email building blocks. Clients strip <style> and most modern CSS, so
// the shell is a table with inline styles and stays readable with CSS or
// images blocked.
import { html, type Html, type Interpolation } from "./html";

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function layout(options: {
  readonly title: string;
  readonly preview: string;
  readonly body: Html;
}) {
  return html`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${options.title}</title>
      </head>
      <body style="margin:0;padding:0;background:#f4f5f7;">
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${options.preview}</div>
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          style="background:#f4f5f7;"
        >
          <tr>
            <td align="center" style="padding:32px 12px;">
              <table
                role="presentation"
                width="100%"
                cellpadding="0"
                cellspacing="0"
                style="max-width:560px;background:#ffffff;border-radius:10px;"
              >
                <tr>
                  <td
                    style="padding:32px;font-family:${FONT};font-size:15px;line-height:1.55;color:#1f2937;"
                  >
                    ${options.body}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>`;
}

export const heading = (content: Interpolation) =>
  html`<h1
    style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:1.3;color:#111827;"
  >
    ${content}
  </h1>`;

export const paragraph = (content: Interpolation) =>
  html`<p style="margin:0 0 16px;color:#4b5563;">${content}</p>`;

/** A call-to-action link. Only http(s) URLs are accepted, so `javascript:` links cannot slip in. */
export function button(options: { readonly href: string; readonly label: string }) {
  const protocol = new URL(options.href).protocol;
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error(`Refusing non-http(s) link in email: ${protocol}`);
  }
  return html`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
    <tr>
      <td style="border-radius:6px;background:#111827;">
        <a
          href="${options.href}"
          style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;"
          >${options.label}</a
        >
      </td>
    </tr>
  </table>`;
}
