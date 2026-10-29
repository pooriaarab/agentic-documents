import type { AgenticDoc } from "./doc.js";
import type { PmNode } from "./markdown.js";

export const EXPORT_FORMATS = ["md", "html", "odt"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportOptions {
  /** Keep `<img>` for web and relative sources. Opening the page then asks those hosts for the image. Off by default. */
  remoteImages?: boolean;
}

export interface ExportResult {
  format: ExportFormat;
  contentType: string;
  encoding: "utf8" | "base64";
  data: string;
  /** One line for each part of the document that the format cannot hold. Empty when nothing was lost. */
  warnings: string[];
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Only web, mail, and relative links. A `javascript:` link becomes `#`. */
const url = (value: unknown): string => (/^(https?:|mailto:|[^:]*$)/i.test(String(value ?? "").trim()) ? esc(String(value).trim()) : "#");

const integer = (value: unknown, fallback: number): number => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback);

const INLINE_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;

const textOf = (node: PmNode): string => node.text ?? (node.content ?? []).map(textOf).join("");

const MARK_TAGS: Record<string, string> = { bold: "strong", italic: "em", strike: "s", code: "code" };

/** An image the page can show without a request. Any other source becomes its alt text, unless remote images are on. */
function image(node: PmNode, remote: boolean): string {
  const src = String(node.attrs?.src ?? "").trim();
  const alt = esc(node.attrs?.alt);
  if (INLINE_IMAGE.test(src)) return `<img src="${src}" alt="${alt}">`;
  if (remote && url(src) !== "#") return `<img src="${url(src)}" alt="${alt}">`;
  return `<span class="image">[image${alt ? `: ${alt}` : ""}]</span>`;
}

function inline(node: PmNode, remote: boolean): string {
  if (node.type === "hardBreak") return "<br>";
  if (node.type === "image") return image(node, remote);
  return (node.marks ?? []).reduce((html, mark) => {
    if (mark.type === "link") return `<a href="${url(mark.attrs?.href)}">${html}</a>`;
    const tag = MARK_TAGS[mark.type];
    return tag ? `<${tag}>${html}</${tag}>` : html;
  }, esc(node.text));
}

function block(node: PmNode, remote: boolean): string {
  const kids = (node.content ?? []).map((n) => block(n, remote)).join("");
  const text = (node.content ?? []).map((n) => inline(n, remote)).join("");
  switch (node.type) {
    case "paragraph":
      return `<p>${text}</p>\n`;
    case "heading": {
      const level = Math.min(6, Math.max(1, integer(node.attrs?.level, 1)));
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
      return `<ol start="${integer(node.attrs?.start, 1)}">\n${kids}</ol>\n`;
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
function toHtml(blocks: PmNode[], remote: boolean): string {
  const title = textOf(blocks.find((b) => b.type === "heading") ?? { type: "doc" }) || "Document";
  const css = "body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.5}table{border-collapse:collapse}td,th{border:1px solid #888;padding:.25rem .5rem}pre{overflow:auto}";
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${esc(title)}</title>\n<style>${css}</style>\n</head>\n<body>\n${blocks.map((b) => block(b, remote)).join("")}</body>\n</html>\n`;
}

/** Render a document as Markdown or HTML text. */
export function exportText(doc: AgenticDoc, format: "md" | "html", options: ExportOptions = {}): string {
  return format === "html" ? toHtml(doc.toJSON().content ?? [], options.remoteImages === true) : doc.toMarkdown();
}
