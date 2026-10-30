import type { AgenticDoc } from "./doc.js";
import { exportFile } from "./formats.js";
import { toBase64 } from "./package.js";
import { EXPORT_FORMATS, exportText, type ExportFormat, type ExportOptions, type ExportResult } from "./render.js";

export { EXPORT_FORMATS, type ExportFormat, type ExportOptions, type ExportResult };

export function exportDoc(doc: AgenticDoc, format: ExportFormat, options: ExportOptions = {}): ExportResult {
  if (format === "odt" || format === "docx") {
    const file = exportFile(doc, format);
    return { format, contentType: file.contentType, encoding: "base64", data: toBase64(file.data as Uint8Array), warnings: file.warnings };
  }
  const contentType = format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8";
  return { format, contentType, encoding: "utf8", data: exportText(doc, format, options), warnings: [] };
}
