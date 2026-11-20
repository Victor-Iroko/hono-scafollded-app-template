import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { html, htmlToText, raw } from "../../../src/integrations/email/html";
import { button } from "../../../src/integrations/email/layout";
import { renderEmail } from "../../../src/integrations/email/templates";

describe("html", () => {
  test("escapes interpolated values", () => {
    const name = `<script>alert("x")</script>`;
    expect(html`<p>${name}</p>`.value).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>",
    );
  });

  test("keeps nested html, raw markup and arrays as markup", () => {
    const items = [html`<li>${"a & b"}</li>`, html`<li>c</li>`];
    // `markup` aliases `html` so the formatter leaves the exact markup alone.
    const markup = html;
    expect(markup`<ul>${items}</ul>${raw("<hr>")}`.value).toBe(
      "<ul><li>a &amp; b</li><li>c</li></ul><hr>",
    );
  });

  test("renders null and undefined as nothing", () => {
    expect(html`<p>${null}${undefined}</p>`.value).toBe("<p></p>");
  });

  test("converts markup to readable text with link targets", () => {
    const text = htmlToText('<h1>Hi</h1><p>Click <a href="https://x.test/v">here</a></p>');
    expect(text).toBe("Hi\nClick here: https://x.test/v");
  });

  test("refuses non-http links in buttons", () => {
    expect(() => button({ href: "javascript:alert(1)", label: "x" })).toThrow();
  });
});

describe("renderEmail", () => {
  test("renders subject, html and text, escaping user data", async () => {
    const email = await Effect.runPromise(
      renderEmail("welcome", { name: "<b>Ada</b>", loginUrl: "https://app.test/login" }),
    );

    expect(email.subject).toBe("Welcome to Acme, <b>Ada</b>");
    expect(email.html).toContain("Welcome, &lt;b&gt;Ada&lt;/b&gt;");
    expect(email.html).not.toContain("<b>Ada</b>");
    expect(email.text).toContain("Sign in: https://app.test/login");
  });

  test("fails when the data does not match the template", async () => {
    const exit = await Effect.runPromise(Effect.exit(renderEmail("verifyEmail", { name: "Ada" })));
    expect(exit._tag).toBe("Failure");
  });
});
