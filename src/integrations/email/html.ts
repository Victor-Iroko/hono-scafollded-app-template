// A tagged template for email markup. Every interpolated value is escaped
// unless it is itself `html` output (or wrapped in `raw`), so user data such as
// a name can never inject markup.
//
//   html`<p>Hi ${name}</p>`            name is escaped
//   html`<div>${heading("Hi")}</div>`  nested html is kept as markup

const HTML = Symbol.for("app/email/Html");

export interface Html {
  readonly [HTML]: true;
  readonly value: string;
}

export type Interpolation =
  | Html
  | string
  | number
  | null
  | undefined
  | ReadonlyArray<Interpolation>;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);

const isHtml = (value: unknown): value is Html =>
  typeof value === "object" && value !== null && HTML in value;

/** Marks trusted markup so it is not escaped. Never pass user input. */
export const raw = (value: string): Html => ({ [HTML]: true, value });

const render = (value: Interpolation): string => {
  if (value === null || value === undefined) return "";
  if (isHtml(value)) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(String(value));
};

export function html(strings: TemplateStringsArray, ...values: ReadonlyArray<Interpolation>): Html {
  let output = strings[0] ?? "";
  values.forEach((value, index) => {
    output += render(value) + (strings[index + 1] ?? "");
  });
  return raw(output);
}

/** Plain-text fallback derived from rendered HTML; templates may supply their own. */
export function htmlToText(markup: string): string {
  return markup
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi, "$2: $1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/^ +| +$/gm, "")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
