// File formats for an app that embeds the editor. ODT and DOCX go through the neutral text model of agentic-formats,
// so this package holds no zip or XML code for them. Markdown and HTML use this package's own mapping.
import { DEFAULT_LIMITS, FormatError, readDocx, readOdt, writeDocx, writeOdt, type Block, type Inline, type Limits, type Mark, type TextDoc } from "agentic-formats";
import { AgenticDoc, checkAuthor, DocError, type DocOptions, type Principal } from "./doc.js";
import { exportText, type ExportOptions } from "./render.js";
import type { PmNode } from "./markdown.js";
import { DATA_IMAGE, fromBase64, toBase64 } from "./package.js";
import { safeHref } from "./xml.js";

const IMPORT_FORMATS = ["md", "odt", "docx"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];
const FILE_FORMATS = ["md", "html", "odt", "docx"] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CONTENT_TYPES: Record<FileFormat, string> = {
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  odt: "application/vnd.oasis.opendocument.text",
  docx: DOCX_MIME,
};

export interface ImportOptions {
  /** Caps for the file. A file that goes past one is refused, never trimmed. The defaults are those of agentic-formats. */
  limits?: Partial<Limits>;
  doc?: DocOptions;
}

export interface ImportResult {
  doc: AgenticDoc;
  /** The title the file holds, if any. */
  title?: string;
  /** One line for each part of the file that the document cannot hold. Empty when nothing was lost. */
  warnings: string[];
}

export interface FileResult {
  format: FileFormat;
  contentType: string;
  /** Text for `md` and `html`. File bytes for `odt` and `docx`. */
  data: string | Uint8Array;
  /** One line for each part of the document that the format cannot hold. Empty when nothing was lost. */
  warnings: string[];
}

const PM_MARKS: Record<string, Mark> = { bold: "bold", italic: "italic", strike: "strike", code: "code" };
const MODEL_IMAGE = /^image\/(png|jpeg|gif)$/;
const TASK = ["☐ ", "☑ "];

/** Collects warnings once per kind, so a long file does not repeat one line a thousand times. */
const warner = () => {
  const seen = new Set<string>();
  return { warn: (line: string) => void seen.add(line), list: () => [...seen] };
};

// ---------- blocks to the neutral model ----------

/** Map document blocks to the neutral text model. A part the model cannot hold keeps its text and adds a warning. */
export function toTextDoc(blocks: PmNode[], title?: string): { model: TextDoc; warnings: string[] } {
  const { warn, list } = warner();

  const inlines = (nodes: PmNode[] = [], extra: Mark[] = []): Inline[] =>
    nodes.flatMap((node): Inline[] => {
      if (node.type === "hardBreak") return [{ type: "break" }];
      if (node.type === "image") {
        const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
        const found = DATA_IMAGE.exec(String(node.attrs?.src ?? "").trim());
        if (found && MODEL_IMAGE.test(found[1].toLowerCase())) {
          try {
            return [{ type: "image", data: fromBase64(found[2]), mime: found[1].toLowerCase() as "image/png", ...(alt ? { alt } : {}) }];
          } catch {
            /* bad base64: fall through to the text */
          }
        }
        warn("an image that is not an embedded PNG, JPEG, or GIF is kept as its alt text");
        return [{ type: "text", text: `[image${alt ? `: ${alt}` : ""}]` }];
      }
      if (!node.text) return [];
      const marks = [...extra, ...(node.marks ?? []).flatMap((m) => (PM_MARKS[m.type] ? [PM_MARKS[m.type]] : []))];
      const href = safeHref((node.marks ?? []).find((m) => m.type === "link")?.attrs?.href);
      return [{ type: "text", text: node.text, ...(marks.length ? { marks } : {}), ...(href ? { href } : {}) }];
    });

  const listOf = (node: PmNode): Block => {
    const items = (node.content ?? []).map((item) => {
      const [first, ...rest] = item.content ?? [];
      const content = inlines(first?.content);
      if (item.type === "taskItem") content.unshift({ type: "text", text: TASK[item.attrs?.checked ? 1 : 0] });
      let sublist: Block | undefined;
      for (const child of rest) {
        if (!sublist && /^(bulletList|orderedList|taskList)$/.test(child.type)) sublist = listOf(child);
        else {
          warn("a list item with more than one paragraph is kept as one paragraph with line breaks");
          for (const b of toBlocks(child)) content.push({ type: "break" }, ...textOfBlock(b));
        }
      }
      return { content, ...(sublist ? { sublist: sublist as Extract<Block, { type: "list" }> } : {}) };
    });
    if (node.type === "orderedList" && Number(node.attrs?.start ?? 1) !== 1) warn("a numbered list that does not start at 1 starts at 1");
    return { type: "list", ordered: node.type === "orderedList", items };
  };

  /** The inline text of a block, for a place that holds only inline content. */
  const textOfBlock = (b: Block): Inline[] =>
    b.type === "list" ? b.items.flatMap((i, n) => [...(n ? [{ type: "break" } as Inline] : []), ...i.content]) : b.type === "table" ? b.rows.flat(2).flatMap(textOfBlock) : b.content;

  const toBlocks = (node: PmNode): Block[] => {
    switch (node.type) {
      case "paragraph":
        return [{ type: "paragraph", content: inlines(node.content) }];
      case "heading": {
        const level = Math.min(6, Math.max(1, Math.trunc(Number(node.attrs?.level)) || 1)) as 1;
        return [{ type: "heading", level, content: inlines(node.content) }];
      }
      case "blockquote":
        warn("a quote is kept as plain paragraphs");
        return (node.content ?? []).flatMap(toBlocks);
      case "codeBlock": {
        warn("a code block is kept as a paragraph of code text");
        const lines = (node.content ?? []).map((t) => t.text ?? "").join("").split("\n");
        return [{ type: "paragraph", content: lines.flatMap((line, i): Inline[] => [...(i ? [{ type: "break" } as Inline] : []), ...(line ? [{ type: "text", text: line, marks: ["code"] } as Inline] : [])]) }];
      }
      case "horizontalRule":
        warn("a horizontal rule is left out");
        return [];
      case "bulletList":
      case "orderedList":
      case "taskList":
        return [listOf(node)];
      case "table": {
        const rows = node.content ?? [];
        const header = rows.length > 0 && (rows[0].content ?? []).length > 0 && (rows[0].content ?? []).every((c) => c.type === "tableHeader");
        return [{ type: "table", ...(header ? { header: true } : {}), rows: rows.map((r) => (r.content ?? []).map((c) => (c.content ?? []).flatMap(toBlocks))) }];
      }
      default:
        warn(`a ${node.type} block is left out`);
        return [];
    }
  };

  const model: TextDoc = { ...(title ? { title } : {}), blocks: blocks.flatMap(toBlocks) };
  return { model, warnings: list() };
}

// ---------- the neutral model to blocks ----------

/** Map the neutral text model to document blocks. A part the editor cannot hold keeps its text and adds a warning. */
export function fromTextDoc(model: TextDoc): { blocks: PmNode[]; title?: string; warnings: string[] } {
  const { warn, list } = warner();

  const text = (value: string, marks: PmNode["marks"] = []): PmNode[] => (value ? [{ type: "text", text: value, ...(marks.length ? { marks } : {}) }] : []);

  const inlines = (nodes: Inline[]): PmNode[] =>
    nodes.flatMap((node): PmNode[] => {
      switch (node.type) {
        case "break":
          return [{ type: "hardBreak" }];
        case "image":
          if (!MODEL_IMAGE.test(node.mime)) {
            warn("an image that is not a PNG, JPEG, or GIF is kept as its alt text");
            return text(`[image${node.alt ? `: ${node.alt}` : ""}]`);
          }
          return [{ type: "image", attrs: { src: `data:${node.mime};base64,${toBase64(node.data)}`, alt: node.alt ?? null, title: null } }];
        case "footnote":
          warn("a footnote is kept as text in brackets");
          return [...text(" ["), ...inlines(node.content), ...text("]")];
        case "text": {
          const marks: NonNullable<PmNode["marks"]> = [];
          for (const mark of node.marks ?? []) {
            if (mark === "bold" || mark === "italic" || mark === "strike" || mark === "code") marks.push({ type: mark });
            else warn(`the ${mark} mark is left out; the text stays`);
          }
          const href = node.href === undefined ? undefined : safeHref(node.href);
          if (node.href !== undefined && !href) warn("a link that is not a web, mail, or relative address is left out; the text stays");
          if (href) marks.push({ type: "link", attrs: { href } });
          // The code mark holds no other mark in this schema, so code text keeps only that one.
          if (marks.length > 1 && marks.some((m) => m.type === "code")) {
            warn("a mark or a link on code text is left out; the text stays as code");
            return text(node.text, [{ type: "code" }]);
          }
          return text(node.text, marks);
        }
        default:
          return [];
      }
    });

  const paragraph = (content: Inline[]): PmNode => ({ type: "paragraph", ...(content.length ? { content: inlines(content) } : {}) });

  const toNodes = (block: Block): PmNode[] => {
    switch (block.type) {
      case "heading":
        return [{ type: "heading", attrs: { level: block.level }, content: inlines(block.content) }];
      case "paragraph":
        return [paragraph(block.content)];
      case "list":
        return [
          {
            type: block.ordered ? "orderedList" : "bulletList",
            ...(block.ordered ? { attrs: { start: 1, type: null } } : {}),
            content: block.items.map((item) => ({ type: "listItem", content: [paragraph(item.content), ...(item.sublist ? toNodes(item.sublist) : [])] })),
          },
        ];
      case "table": {
        const rows = block.rows.filter((r) => r.length > 0);
        if (rows.length === 0) return [];
        return [
          {
            type: "table",
            content: rows.map((row, i) => ({
              type: "tableRow",
              content: row.map((cell) => {
                const content = cell.flatMap(toNodes);
                return { type: block.header && i === 0 ? "tableHeader" : "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: content.length ? content : [{ type: "paragraph" }] };
              }),
            })),
          },
        ];
      }
      default:
        return [];
    }
  };

  // Strip empty text nodes the schema refuses, so an odd file still makes a valid document.
  const prune = (node: PmNode): PmNode => (node.content ? { ...node, content: node.content.filter((n) => n.type !== "text" || n.text).map(prune) } : node);
  const blocks = model.blocks.flatMap(toNodes).map(prune);
  return { blocks, ...(model.title ? { title: model.title } : {}), warnings: list() };
}

// ---------- files ----------

const formatFailure = (error: unknown): never => {
  if (error instanceof FormatError) throw new DocError("INVALID_INPUT", `the file was refused (${error.code}): ${error.message}`);
  throw error;
};

/** Read a file into a new document. The author makes the one `create` edit, so text from an agent stays labeled. */
export function importFile(input: string | Uint8Array, format: ImportFormat, author: Principal, options: ImportOptions = {}): ImportResult {
  checkAuthor(author);
  if (!IMPORT_FORMATS.includes(format)) throw new DocError("INVALID_INPUT", `import format must be one of ${IMPORT_FORMATS.join(", ")}`);
  const maxBytes = options.limits?.maxInputBytes ?? DEFAULT_LIMITS.maxInputBytes;
  if (format === "md") {
    let markdown: string;
    try {
      markdown = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      throw new DocError("INVALID_INPUT", "a md file must be UTF-8 text");
    }
    if (new TextEncoder().encode(markdown).length > maxBytes) throw new DocError("INVALID_INPUT", `the file is larger than ${maxBytes} bytes`);
    return { doc: AgenticDoc.fromMarkdown(markdown, author, options.doc), warnings: [] };
  }
  if (!(input instanceof Uint8Array)) throw new DocError("INVALID_INPUT", `a ${format} file must be bytes, not text`);
  let read: { model: TextDoc; warnings: string[] };
  try {
    read = format === "odt" ? readOdt(input, options.limits) : readDocx(input, options.limits);
  } catch (error) {
    return formatFailure(error);
  }
  const mapped = fromTextDoc(read.model);
  return {
    doc: AgenticDoc.fromBlocks(mapped.blocks, author, options.doc),
    ...(mapped.title ? { title: mapped.title } : {}),
    warnings: [...read.warnings, ...mapped.warnings],
  };
}

/** Write blocks as an OpenDocument text file (.odt). It drops the warnings; use `exportFile` or `exportDoc` to read what the file cannot hold. */
export function exportOdt(blocks: PmNode[]): Uint8Array {
  try {
    return writeOdt(toTextDoc(blocks).model).bytes;
  } catch (error) {
    return formatFailure(error);
  }
}

/** Write a document as a file. `title` goes into the ODT and DOCX metadata. */
export function exportFile(doc: AgenticDoc, format: FileFormat, options: ExportOptions & { title?: string } = {}): FileResult {
  if (!FILE_FORMATS.includes(format)) throw new DocError("INVALID_INPUT", `export format must be one of ${FILE_FORMATS.join(", ")}`);
  if (format === "md" || format === "html") return { format, contentType: CONTENT_TYPES[format], data: exportText(doc, format, options), warnings: [] };
  const { model, warnings } = toTextDoc(doc.toJSON().content ?? [], options.title);
  let written: { bytes: Uint8Array; warnings: string[] };
  try {
    written = format === "odt" ? writeOdt(model) : writeDocx(model);
  } catch (error) {
    return formatFailure(error);
  }
  return { format, contentType: CONTENT_TYPES[format], data: written.bytes, warnings: [...warnings, ...written.warnings] };
}
