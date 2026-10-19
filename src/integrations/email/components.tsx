import type { PropsWithChildren } from "hono/jsx";

const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Clients strip <style> and most modern CSS, so the shell is a table with
 * inline styles, and stays readable when CSS or images are blocked.
 */
export function EmailLayout({
  preview,
  title,
  children,
}: PropsWithChildren<{ preview: string; title: string }>) {
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
      </head>
      <body style="margin:0;padding:0;background:#f4f5f7;">
        {/* Inbox preview line, hidden once the body renders. */}
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;">{preview}</div>
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
                    style={`padding:32px;font-family:${font};font-size:15px;line-height:1.55;color:#1f2937;`}
                  >
                    {children}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  );
}

export function Heading({ children }: PropsWithChildren) {
  return (
    <h1 style={`margin:0 0 16px;font-family:${font};font-size:22px;line-height:1.3;color:#111827;`}>
      {children}
    </h1>
  );
}

export function Paragraph({ children }: PropsWithChildren) {
  return <p style="margin:0 0 16px;color:#4b5563;">{children}</p>;
}

export function Button({ href, children }: PropsWithChildren<{ href: string }>) {
  return (
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr>
        <td style="border-radius:6px;background:#111827;">
          <a
            href={href}
            style={`display:inline-block;padding:12px 22px;font-family:${font};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;`}
          >
            {children}
          </a>
        </td>
      </tr>
    </table>
  );
}
