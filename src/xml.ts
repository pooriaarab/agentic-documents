/** A link target for a file: web, mail, in-page, or relative. Anything else (`javascript:`) is dropped. */
export const safeHref = (value: unknown): string | undefined => {
  const href = String(value ?? "").trim();
  return /^(https?:|mailto:|#|[^:]*$)/i.test(href) ? href : undefined;
};
