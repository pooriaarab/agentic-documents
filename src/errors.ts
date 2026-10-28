export type DocErrorCode = "NO_MATCH" | "AMBIGUOUS_MATCH" | "STALE_ANCHOR" | "NO_SECTION" | "INVALID_AUTHOR" | "INVALID_INPUT" | "NO_THREAD" | "NO_SUGGESTION" | "ALREADY_DECIDED" | "FORBIDDEN" | "NO_DOCUMENT" | "DOCUMENT_EXISTS";

export class DocError extends Error {
  constructor(
    readonly code: DocErrorCode,
    message: string,
    readonly matches: { occurrence: number; context: string }[] = [],
  ) {
    super(message);
    this.name = "DocError";
  }
}
