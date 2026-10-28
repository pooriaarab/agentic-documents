import { strToU8, zipSync } from "fflate";
import type { PmNode } from "./markdown.js";
import { DATA_IMAGE, FIXED_DATE, IMAGE_TYPES, fromBase64, imageSize } from "./package.js";
import { safeHref, xmlEscape as esc } from "./xml.js";

export const ODT_MIME = "application/vnd.oasis.opendocument.text";
// ---------- export ----------

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" office:version="1.3"';
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';
const SPANS: Record<string, string> = { bold: "B", italic: "I", strike: "S", code: "Source_20_Text" };
const TASK = ["☐ ", "☑ "];
const LEVELS = (kind: "bullet" | "number") =>
  Array.from({ length: 10 }, (_, i) =>
    kind === "bullet"
      ? `<text:list-level-style-bullet text:level="${i + 1}" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:margin-left="${(i + 1) * 0.63}cm" fo:text-indent="-0.63cm"/></style:list-level-properties></text:list-level-style-bullet>`
      : `<text:list-level-style-number text:level="${i + 1}" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:margin-left="${(i + 1) * 0.63}cm" fo:text-indent="-0.63cm"/></style:list-level-properties></text:list-level-style-number>`,
  ).join("");
const SIZES = [24, 18, 14, 12, 11, 10];
const STYLES = `${XML}<office:document-styles ${NS}><office:styles>
<style:style style:name="Standard" style:family="paragraph" style:class="text"/>
${SIZES.map((s, i) => `<style:style style:name="Heading_20_${i + 1}" style:display-name="Heading ${i + 1}" style:family="paragraph" style:parent-style-name="Standard" style:class="text"><style:text-properties fo:font-size="${s}pt" fo:font-weight="bold"/></style:style>`).join("\n")}
<style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:margin-left="1cm" fo:margin-right="1cm"/></style:style>
<style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:text-properties fo:font-family="Liberation Mono, Courier New, monospace" fo:font-size="10pt"/></style:style>
<style:style style:name="Horizontal_20_Line" style:display-name="Horizontal Line" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:border-bottom="0.5pt solid #808080" fo:padding="0cm" fo:margin-bottom="0.3cm"/></style:style>
<style:style style:name="Source_20_Text" style:display-name="Source Text" style:family="text"><style:text-properties fo:font-family="Liberation Mono, Courier New, monospace"/></style:style>
</office:styles></office:document-styles>`;
const AUTO = `<style:style style:name="B" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="I" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="S" style:family="text"><style:text-properties style:text-line-through-style="solid"/></style:style>
<text:list-style style:name="Bullets">${LEVELS("bullet")}</text:list-style>
<text:list-style style:name="Numbering">${LEVELS("number")}</text:list-style>`;

interface Out {
  images: { name: string; type: string; data: Uint8Array }[];
  tables: number;
}

const spaced = (s: string): string =>
  esc(s)
    .replace(/\t/g, "<text:tab/>")
    .replace(/\n/g, "<text:line-break/>")
    .replace(/ +/g, (run, at: number, all: string) => (at === 0 || at + run.length === all.length ? `<text:s text:c="${run.length}"/>` : run.length > 1 ? ` <text:s text:c="${run.length - 1}"/>` : run));

function image(node: PmNode, out: Out): string {
  const alt = String(node.attrs?.alt ?? "");
  const found = DATA_IMAGE.exec(String(node.attrs?.src ?? "").trim());
  let data: Uint8Array | undefined;
  try {
    data = found ? fromBase64(found[2]) : undefined;
  } catch {
    data = undefined;
  }
  // A remote image is not linked: the viewer would ask its host for it when the file opens.
  if (!found || !data) return spaced(`[image${alt ? `: ${alt}` : ""}]`);
  const ext = Object.keys(IMAGE_TYPES).find((k) => IMAGE_TYPES[k] === found[1].toLowerCase())!;
  const name = `Image${out.images.length + 1}`;
  out.images.push({ name: `Pictures/${name}.${ext}`, type: found[1].toLowerCase(), data });
  const [w, h] = imageSize(data) ?? [320, 240];
  const scale = Math.min(1, 16 / ((w * 2.54) / 96));
  const cm = (px: number) => ((px * 2.54 * scale) / 96).toFixed(2);
  return `<draw:frame draw:name="${name}" text:anchor-type="as-char" svg:width="${cm(w)}cm" svg:height="${cm(h)}cm"><draw:image xlink:href="Pictures/${name}.${ext}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/><svg:title>${esc(alt)}</svg:title></draw:frame>`;
}

function inline(nodes: PmNode[], out: Out): string {
  return nodes
    .map((node) => {
      if (node.type === "hardBreak") return "<text:line-break/>";
      if (node.type === "image") return image(node, out);
      return (node.marks ?? []).reduce((xml, mark) => {
        if (mark.type === "link") {
          const href = safeHref(mark.attrs?.href);
          return href ? `<text:a xlink:type="simple" xlink:href="${esc(href)}">${xml}</text:a>` : xml;
        }
        return SPANS[mark.type] ? `<text:span text:style-name="${SPANS[mark.type]}">${xml}</text:span>` : xml;
      }, spaced(node.text ?? ""));
    })
    .join("");
}

function block(node: PmNode, out: Out, style = "Standard"): string {
  const kids = node.content ?? [];
  const p = (name: string, inner: string) => `<text:p text:style-name="${name}">${inner}</text:p>`;
  switch (node.type) {
    case "paragraph":
      return p(style, inline(kids, out));
    case "heading": {
      const level = Math.min(6, Math.max(1, Math.trunc(Number(node.attrs?.level)) || 1));
      return `<text:h text:style-name="Heading_20_${level}" text:outline-level="${level}">${inline(kids, out)}</text:h>`;
    }
    case "blockquote":
      return kids.map((k) => block(k, out, "Quotations")).join("");
    case "codeBlock":
      return p("Preformatted_20_Text", spaced(kids.map((k) => k.text ?? "").join("")));
    case "horizontalRule":
      return `<text:p text:style-name="Horizontal_20_Line"/>`;
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const ordered = node.type === "orderedList";
      const start = Number(node.attrs?.start ?? 1);
      const items = kids.map((item, i) => {
        const [first, ...rest] = item.content ?? [];
        const mark = item.type === "taskItem" && first ? { ...first, content: [{ type: "text", text: TASK[item.attrs?.checked ? 1 : 0] }, ...(first.content ?? [])] } : first;
        const attr = ordered && i === 0 && start !== 1 ? ` text:start-value="${Math.trunc(start) || 1}"` : "";
        return `<text:list-item${attr}>${[mark, ...rest].filter(Boolean).map((k) => block(k, out)).join("")}</text:list-item>`;
      });
      return `<text:list text:style-name="${ordered ? "Numbering" : "Bullets"}">${items.join("")}</text:list>`;
    }
    case "table": {
      const cols = Math.max(0, ...kids.map((r) => r.content?.length ?? 0));
      const row = (r: PmNode) => `<table:table-row>${(r.content ?? []).map((c) => `<table:table-cell office:value-type="string">${(c.content ?? []).map((b) => block(b, out)).join("")}</table:table-cell>`).join("")}</table:table-row>`;
      const header = kids[0]?.content?.length && kids[0].content.every((c) => c.type === "tableHeader");
      const rows = header ? `<table:table-header-rows>${row(kids[0])}</table:table-header-rows>${kids.slice(1).map(row).join("")}` : kids.map(row).join("");
      return `<table:table table:name="Table${++out.tables}">${cols ? `<table:table-column table:number-columns-repeated="${cols}"/>` : ""}${rows}</table:table>`;
    }
    default:
      return "";
  }
}

/** Write blocks as an OpenDocument text file (.odt): content, styles, and images as embedded files. */
export function exportOdt(blocks: PmNode[]): Uint8Array {
  const out: Out = { images: [], tables: 0 };
  const body = blocks.map((b) => block(b, out)).join("\n");
  const content = `${XML}<office:document-content ${NS}><office:automatic-styles>${AUTO}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
  const entries = [
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${ODT_MIME}"/>`,
    ...["content.xml", "styles.xml", "meta.xml"].map((n) => `<manifest:file-entry manifest:full-path="${n}" manifest:media-type="text/xml"/>`),
    ...out.images.map((i) => `<manifest:file-entry manifest:full-path="${i.name}" manifest:media-type="${i.type}"/>`),
  ];
  const meta = `${XML}<office:document-meta ${NS}><office:meta><meta:generator>agentic-documents</meta:generator></office:meta></office:document-meta>`;
  const part = (text: string) => [strToU8(text), { mtime: FIXED_DATE }] as [Uint8Array, { mtime: Date }];
  return zipSync({
    mimetype: [strToU8(ODT_MIME), { level: 0, mtime: FIXED_DATE }], // first and stored, so file sniffers can read it
    "META-INF/manifest.xml": part(`${XML}<manifest:manifest ${NS}>${entries.join("")}</manifest:manifest>`),
    "content.xml": part(content),
    "styles.xml": part(STYLES),
    "meta.xml": part(meta),
    ...Object.fromEntries(out.images.map((i) => [i.name, [i.data, { mtime: FIXED_DATE }] as [Uint8Array, { mtime: Date }]])),
  });
}
