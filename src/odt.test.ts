// Failure modes first: each test names one way the exporter can write a file an editor cannot use.
import { unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { exportOdt, ODT_MIME } from "./odt.js";
import type { PmNode } from "./markdown.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const png = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
const t = (text: string, ...marks: string[]): PmNode => ({ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...content: PmNode[]): PmNode => ({ type: "paragraph", content });
const xmlOf = (blocks: PmNode[]) => new TextDecoder().decode(unzipSync(exportOdt(blocks))["content.xml"]);

describe("the package", () => {
  test("the mimetype is the first part and stored, and the standard parts are there", () => {
    const bytes = exportOdt([p(t("x"))]);
    expect(new TextDecoder().decode(bytes.slice(30, 38))).toBe("mimetype");
    expect(new TextDecoder().decode(bytes.slice(38, 38 + ODT_MIME.length))).toBe(ODT_MIME);
    expect(Object.keys(unzipSync(bytes))).toEqual(expect.arrayContaining(["META-INF/manifest.xml", "content.xml", "styles.xml", "meta.xml"]));
  });

  test("the same blocks give the same bytes", () => {
    const blocks = [p(t("x", "bold"))];
    expect(exportOdt(blocks)).toEqual(exportOdt(blocks));
  });

  test("an empty document is still a valid package", () => {
    expect(xmlOf([])).toContain("<office:text></office:text>");
  });
});

describe("text", () => {
  test("a control character, markup, and a lone surrogate cannot break the XML", () => {
    const xml = xmlOf([p(t("a\u0000b <i> & \"q\" \uD800 end"))]);
    expect(xml).toContain('ab &lt;i&gt; &amp; &quot;q&quot; <text:s text:c="1"/>end');
    expect(xml).not.toMatch(/[\u0000-\u0008\uD800]/);
  });

  test("spaces, tabs, and breaks keep their meaning", () => {
    const xml = xmlOf([p(t("  lead  two\tend "), { type: "hardBreak" }, t("x"))]);
    expect(xml).toContain('<text:s text:c="2"/>lead <text:s text:c="1"/>two<text:tab/>end<text:s text:c="1"/><text:line-break/>x');
  });

  test("marks become spans, and an unsafe link is written as plain text", () => {
    const xml = xmlOf([p(t("b", "bold", "italic"), { ...t("l"), marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }, { ...t("ok"), marks: [{ type: "link", attrs: { href: "https://example.org/?a=1&b=2" } }] })]);
    expect(xml).toContain('<text:span text:style-name="I"><text:span text:style-name="B">b</text:span></text:span>');
    expect(xml).not.toContain("javascript");
    expect(xml).toContain('<text:a xlink:type="simple" xlink:href="https://example.org/?a=1&amp;b=2">ok</text:a>');
  });
});

describe("blocks", () => {
  test("headings, lists, tasks, a code block, a quote, a rule, and a table", () => {
    const item = (type: string, ...content: PmNode[]): PmNode => ({ type, attrs: type === "taskItem" ? { checked: true } : undefined, content });
    const xml = xmlOf([
      { type: "heading", attrs: { level: 9 }, content: [t("H")] },
      { type: "orderedList", attrs: { start: 3 }, content: [item("listItem", p(t("a")), { type: "bulletList", content: [item("listItem", p(t("b")))] })] },
      { type: "taskList", content: [item("taskItem", p(t("done")))] },
      { type: "codeBlock", content: [t("x\n\ny")] },
      { type: "blockquote", content: [p(t("q1")), p(t("q2"))] },
      { type: "horizontalRule" },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [p(t("h"))] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [p(t("c"))] }] }] },
    ]);
    expect(xml).toContain('<text:h text:style-name="Heading_20_6" text:outline-level="6">H</text:h>'); // a level over 6 is clamped
    expect(xml).toContain('<text:list text:style-name="Numbering"><text:list-item text:start-value="3"><text:p text:style-name="Standard">a</text:p><text:list text:style-name="Bullets">');
    expect(xml).toContain('☑<text:s text:c="1"/>done');
    expect(xml).toContain('<text:p text:style-name="Preformatted_20_Text">x<text:line-break/><text:line-break/>y</text:p>');
    expect(xml.match(/text:style-name="Quotations"/g)).toHaveLength(2);
    expect(xml).toContain('<text:p text:style-name="Horizontal_20_Line"/>');
    expect(xml).toContain('<table:table-header-rows><table:table-row><table:table-cell office:value-type="string">');
  });

  test("a table with no header row has no header-rows part, and an empty table has no columns", () => {
    const row = { type: "tableRow", content: [{ type: "tableCell", content: [p(t("c"))] }] };
    expect(xmlOf([{ type: "table", content: [row] }])).not.toContain("table-header-rows");
    expect(xmlOf([{ type: "table", content: [] }])).not.toContain("table-column");
  });
});

describe("images", () => {
  const image = (src: string): PmNode => ({ type: "image", attrs: { src, alt: "dot" } });

  test("an inline image is embedded as a file, with its size read from the header", () => {
    const files = unzipSync(exportOdt([p(image(`data:image/png;base64,${PNG_B64}`))]));
    expect(files["Pictures/Image1.png"]).toEqual(png);
    expect(new TextDecoder().decode(files["META-INF/manifest.xml"])).toContain('manifest:full-path="Pictures/Image1.png" manifest:media-type="image/png"');
    const xml = new TextDecoder().decode(files["content.xml"]);
    expect(xml).toContain('svg:width="0.03cm" svg:height="0.03cm"');
    expect(xml).toContain("<svg:title>dot</svg:title>");
  });

  test("a remote, relative, SVG, or broken image is never linked: its alt text stays", () => {
    for (const src of ["https://tracker.example/a.gif", "/x.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,@@@@"]) {
      const files = unzipSync(exportOdt([p(image(src))]));
      const xml = new TextDecoder().decode(files["content.xml"]);
      expect(xml, src).toContain("[image: dot]");
      expect(xml, src).not.toMatch(/tracker|x\.png|image\/svg|PHN2Zz4/);
      expect(Object.keys(files).some((n) => n.startsWith("Pictures/"))).toBe(false);
    }
  });
});
