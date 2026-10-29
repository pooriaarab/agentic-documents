import { DEFAULT_LIMITS, normalizeTextDoc, readDocx, readOdt, readZip, writeDocx, writeOdt } from "agentic-formats";
import { describe, expect, it } from "vitest";
import { AgenticDoc, DocError, exportDoc, exportOdt } from "./index.js";
import { exportFile, fromTextDoc, importFile, toTextDoc } from "./formats.js";

const ada = { kind: "human" as const, name: "Ada" };
const bot = { kind: "agent_of_human" as const, name: "Scribe" };
// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const MD = [
  "# Plan",
  "",
  "Some **bold**, *italic*, ~~gone~~, `code`, and a [link](https://example.com/a).",
  "",
  "## Steps",
  "",
  "1. First",
  "2. Second",
  "   - inner one",
  "   - inner two",
  "",
  "| Name | Role |",
  "| --- | --- |",
  "| Ada | Writer |",
  "",
  `An image: ![dot](data:image/png;base64,${PNG})`,
  "",
].join("\n");

const bytesOf = (data: string | Uint8Array) => (typeof data === "string" ? new TextEncoder().encode(data) : data);

describe("file formats", () => {
  // Each file format must bring back the same document it wrote.
  for (const format of ["md", "odt", "docx"] as const) {
    it(`a ${format} export imports back to the same Markdown`, () => {
      const doc = AgenticDoc.fromMarkdown(MD, ada);
      const out = exportFile(doc, format);
      expect(out.warnings).toEqual([]);
      const back = importFile(out.data, format, bot);
      expect(back.doc.toMarkdown()).toBe(doc.toMarkdown());
    });
  }

  it("an ODT and a DOCX export are real files that agentic-formats reads", () => {
    const doc = AgenticDoc.fromMarkdown(MD, ada);
    const odt = exportFile(doc, "odt");
    const docx = exportFile(doc, "docx");
    expect(odt.contentType).toBe("application/vnd.oasis.opendocument.text");
    expect(docx.contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    for (const model of [readOdt(bytesOf(odt.data)).model, readDocx(bytesOf(docx.data)).model]) {
      expect(model.blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "heading", "list", "table", "paragraph"]);
    }
  });

  it("an HTML export is a page with the text", () => {
    const out = exportFile(AgenticDoc.fromMarkdown("# Hi\n\nThere", ada), "html");
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.data).toContain("<h1>Hi</h1>");
  });

  it("an import is one edit by the author it gets, so agent-made text stays labeled", () => {
    const { doc } = importFile(exportFile(AgenticDoc.fromMarkdown("Hello", ada), "docx").data, "docx", bot);
    expect(doc.edits().map((e) => [e.op, e.author.kind, e.author.name])).toEqual([["create", "agent_of_human", "Scribe"]]);
  });

  it("an import with no author kind fails and makes nothing", () => {
    expect(() => importFile("Hello", "md", { name: "x" } as never)).toThrow(expect.objectContaining({ code: "INVALID_AUTHOR" }));
  });

  it("bytes that are not a file fail with INVALID_INPUT, not a crash", () => {
    for (const format of ["odt", "docx"] as const) {
      const call = () => importFile(new Uint8Array([1, 2, 3]), format, ada);
      expect(call).toThrow(DocError);
      expect(call).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });

  it("a file over the size limit is refused", () => {
    const big = exportFile(AgenticDoc.fromMarkdown("x".repeat(5000), ada), "odt").data as Uint8Array;
    expect(() => importFile(big, "odt", ada, { limits: { maxInputBytes: 100 } })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("a format it does not know is refused", () => {
    expect(() => importFile("x", "pdf" as never, ada)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => importFile("x", "html" as never, ada)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => exportFile(AgenticDoc.fromMarkdown("x", ada), "pdf" as never)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("text in place of file bytes is refused for odt and docx", () => {
    expect(() => importFile("PK...", "odt", ada)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("a script link in a file is dropped and the text stays", () => {
    const { bytes } = writeOdt({ blocks: [{ type: "paragraph", content: [{ type: "text", text: "click", href: "javascript:alert(1)" }] }] });
    const { doc } = importFile(bytes, "odt", ada);
    expect(doc.toMarkdown().trim()).toBe("click");
  });

  it("every part a file format cannot hold is named in warnings, and its text is kept", () => {
    const doc = AgenticDoc.fromMarkdown("> quoted\n\n---\n\n```\nline 1\nline 2\n```\n\n- [x] done\n\n![far](https://example.com/a.png)", ada);
    const { model, warnings } = toTextDoc(doc.toJSON().content ?? []);
    expect(warnings.join(" ")).toMatch(/quote/);
    expect(warnings.join(" ")).toMatch(/horizontal rule/);
    expect(warnings.join(" ")).toMatch(/code block/);
    expect(warnings.join(" ")).toMatch(/image/);
    const text = JSON.stringify(normalizeTextDoc(model));
    for (const kept of ["quoted", "line 1", "line 2", "☑ done", "[image: far]"]) expect(text).toContain(kept);
  });

  it("marks, footnotes, and images the editor cannot hold are named in warnings, and their text is kept", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]);
    const { blocks, warnings } = fromTextDoc({
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "under", marks: ["underline"] }, { type: "footnote", content: [{ type: "text", text: "a note" }] }, { type: "image", data: gif, mime: "image/gif", alt: "g" }] }],
    });
    expect(warnings.join(" ")).toMatch(/underline/);
    expect(warnings.join(" ")).toMatch(/footnote/);
    expect(JSON.stringify(blocks)).toContain("under");
    expect(JSON.stringify(blocks)).toContain("a note");
    expect(JSON.stringify(blocks)).toContain("data:image/gif;base64,");
  });

  it("a table cell with no text and a list item with no text still make a valid document", () => {
    const { blocks } = fromTextDoc({
      blocks: [
        { type: "table", header: true, rows: [[[], [{ type: "paragraph", content: [{ type: "text", text: "b" }] }]]] },
        { type: "list", ordered: false, items: [{ content: [] }] },
      ],
    });
    const doc = AgenticDoc.fromBlocks(blocks, ada);
    expect(doc.toJSON().content?.map((b) => b.type)).toEqual(["table", "bulletList"]);
  });

  it("bold or linked code text in a file imports as code, and the lost mark is named", () => {
    const { bytes } = writeDocx({
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "npm ci", marks: ["bold", "code"] }, { type: "text", text: " and " }, { type: "text", text: "docs", marks: ["code"], href: "https://example.com" }] }],
    });
    const { doc, warnings } = importFile(bytes, "docx", ada);
    expect(doc.toMarkdown().trim()).toBe("`npm ci` and `docs`");
    expect(warnings.join(" ")).toMatch(/code text/);
  });

  it("Markdown bytes that are not UTF-8 fail with INVALID_INPUT", () => {
    expect(() => importFile(new Uint8Array([0xff, 0xfe, 0x80]), "md", ada)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("an image type the editor cannot hold is named in warnings", () => {
    const { blocks, warnings } = fromTextDoc({ blocks: [{ type: "paragraph", content: [{ type: "image", data: new Uint8Array([60]), mime: "image/svg+xml" as never, alt: "s" }] }] });
    expect(JSON.stringify(blocks)).toContain("[image: s]");
    expect(warnings.join(" ")).toMatch(/image/);
  });
});

describe("the ODT export is safe and says what it loses", () => {
  const contentOf = (bytes: Uint8Array) => new TextDecoder().decode(readZip(bytes, DEFAULT_LIMITS, "odt", (n) => n === "content.xml")["content.xml"]);

  it("the same document gives the same bytes, and the mimetype comes first", () => {
    const blocks = AgenticDoc.fromMarkdown(MD, ada).toJSON().content ?? [];
    expect(exportOdt(blocks)).toEqual(exportOdt(blocks));
    expect(new TextDecoder().decode(exportOdt([]).slice(30, 38))).toBe("mimetype");
  });

  it("an unsafe link, a remote image, and an SVG image are never written", () => {
    const blocks = AgenticDoc.fromMarkdown("[x](javascript:alert(1)) ![a](https://tracker.example/a.gif) ![b](data:image/svg+xml;base64,PHN2Zz4=)", ada).toJSON().content ?? [];
    const xml = contentOf(exportOdt(blocks));
    expect(xml).not.toMatch(/javascript|tracker|svg\+xml|PHN2Zz4/);
    expect(xml).toContain("x");
  });

  it("a control character and markup cannot break the XML", () => {
    const xml = contentOf(exportOdt([{ type: "paragraph", content: [{ type: "text", text: "a\u0000b <i> & \"q\"" }] }]));
    expect(xml).toContain("ab &lt;i&gt; &amp; &quot;q&quot;");
  });

  it("exportDoc lists what the ODT cannot hold, so a caller does not see a silent loss", () => {
    const doc = AgenticDoc.fromMarkdown("3. three\n4. four\n\n---\n\n> quote\n\n```\ncode\n```\n\n![w](data:image/webp;base64,UklGRg==)", ada);
    expect(exportDoc(doc, "odt").warnings).toEqual(
      expect.arrayContaining([
        "a numbered list that does not start at 1 starts at 1",
        "a horizontal rule is left out",
        "a quote is kept as plain paragraphs",
        "a code block is kept as a paragraph of code text",
        "an image that is not an embedded PNG, JPEG, or GIF is kept as its alt text",
      ]),
    );
    expect(exportDoc(doc, "md").warnings).toEqual([]);
  });
});
