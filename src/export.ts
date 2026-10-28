import type { AgenticDoc } from "./doc.js";

export const EXPORT_FORMATS = ["md"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportResult {
  format: ExportFormat;
  contentType: string;
  encoding: "utf8" | "base64";
  data: string;
}

export function exportDoc(doc: AgenticDoc, format: ExportFormat): ExportResult {
  return { format, contentType: "text/markdown; charset=utf-8", encoding: "utf8", data: doc.toMarkdown() };
}
