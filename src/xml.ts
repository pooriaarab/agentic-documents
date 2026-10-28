/** Text safe for XML 1.0: drops characters XML forbids, then escapes `& < > "`. */
export const xmlEscape = (value: unknown): string =>
  String(value ?? "")
    .replace(/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A link target for a file: web, mail, in-page, or relative. Anything else (`javascript:`) is dropped. */
export const safeHref = (value: unknown): string | undefined => {
  const href = String(value ?? "").trim();
  return /^(https?:|mailto:|#|[^:]*$)/i.test(href) ? href : undefined;
};
