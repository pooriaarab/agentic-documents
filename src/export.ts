import type { AgenticDoc } from "./doc.js";
import type { PmNode } from "./markdown.js";

export const EXPORT_FORMATS = ["md", "html"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportResult {
  format: ExportFormat;
  contentType: string;
  encoding: "utf8" | "base64";
  data: string;
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Only web, mail, and relative links. A `javascript:` link becomes `#`. */
const url = (value: unknown): string => (/^(https?:|mailto:|[^:]*$)/i.test(String(value ?? "").trim()) ? esc(String(value).trim()) : "#");

const textOf = (node: PmNode): string => node.text ?? (node.content ?? []).map(textOf).join("");

const MARK_TAGS: Record<string, string> = { bold: "strong", italic: "em", strike: "s", code: "code" };

function inline(node: PmNode): string {
  if (node.type === "hardBreak") return "<br>";
  if (node.type === "image") return `<img src="${url(node.attrs?.src)}" alt="${esc(node.attrs?.alt)}">`;
  return (node.marks ?? []).reduce((html, mark) => {
    if (mark.type === "link") return `<a href="${url(mark.attrs?.href)}">${html}</a>`;
    const tag = MARK_TAGS[mark.type];
    return tag ? `<${tag}>${html}</${tag}>` : html;
  }, esc(node.text));
}

function block(node: PmNode): string {
  const kids = (node.content ?? []).map(block).join("");
  const text = (node.content ?? []).map(inline).join("");
  switch (node.type) {
    case "paragraph":
      return `<p>${text}</p>\n`;
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `<h${level}>${text}</h${level}>\n`;
    }
    case "blockquote":
      return `<blockquote>\n${kids}</blockquote>\n`;
    case "codeBlock": {
      const lang = node.attrs?.language ? ` class="language-${esc(node.attrs.language)}"` : "";
      return `<pre><code${lang}>${esc(textOf(node))}</code></pre>\n`;
    }
    case "horizontalRule":
      return "<hr>\n";
    case "bulletList":
    case "taskList":
      return `<ul>\n${kids}</ul>\n`;
    case "orderedList":
      return `<ol start="${Number(node.attrs?.start ?? 1)}">\n${kids}</ol>\n`;
    case "listItem":
      return `<li>${kids}</li>\n`;
    case "taskItem":
      return `<li><input type="checkbox" disabled${node.attrs?.checked ? " checked" : ""}> ${kids}</li>\n`;
    case "table":
      return `<table>\n${kids}</table>\n`;
    case "tableRow":
      return `<tr>${kids}</tr>\n`;
    case "tableHeader":
      return `<th>${kids}</th>`;
    case "tableCell":
      return `<td>${kids}</td>`;
    default:
      return "";
  }
}

/** A self-contained page. It loads nothing from other hosts: no fonts, scripts, or styles. */
function toHtml(blocks: PmNode[]): string {
  const title = textOf(blocks.find((b) => b.type === "heading") ?? { type: "doc" }) || "Document";
  const css = "body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.5}table{border-collapse:collapse}td,th{border:1px solid #888;padding:.25rem .5rem}pre{overflow:auto}";
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${esc(title)}</title>\n<style>${css}</style>\n</head>\n<body>\n${blocks.map(block).join("")}</body>\n</html>\n`;
}

export function exportDoc(doc: AgenticDoc, format: ExportFormat): ExportResult {
  if (format === "html") {
    return { format, contentType: "text/html; charset=utf-8", encoding: "utf8", data: toHtml(doc.toJSON().content ?? []) };
  }
  return { format, contentType: "text/markdown; charset=utf-8", encoding: "utf8", data: doc.toMarkdown() };
}
