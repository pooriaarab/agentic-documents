import { expect, test, type Page } from "@playwright/test";
import { createClient } from "../src/client.js";
import { ADA } from "./tokens.js";
import { expectAccessible, newPage, pasteHtml, url } from "./helpers.js";

const textbox = (page: Page) => page.getByRole("textbox", { name: "Document text" });
const tool = (page: Page, name: string) => page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name, exact: true });
const markdown = async (id: string) => (await fetch(`${url()}/api/v1/docs/${id}/read`, { headers: { authorization: `Bearer ${ADA}` } })).text();

// A 1 by 1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("the full-screen page and the toolbar write every block, and the stored Markdown has them", async ({ browser }) => {
  const id = `toolbar-${Date.now().toString(36)}`;
  await createClient({ baseUrl: url(), token: ADA }).create({ id, markdown: "" });
  const page = await newPage(await browser.newContext({ viewport: { width: 1200, height: 900 } }), ADA);
  await page.goto(`${url()}/#/d/${id}`);
  await expect(page.getByRole("link", { name: "Documents", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0); // no side bar on a document
  const text = textbox(page);
  await text.click();

  await tool(page, "Text style: Paragraph").click();
  await page.getByRole("menuitem", { name: "Heading 1" }).click();
  await page.keyboard.type("Plan");
  await expect(tool(page, "Text style: Heading 1")).toBeVisible();
  await page.keyboard.press("Enter");
  await tool(page, "Strikethrough").click();
  await page.keyboard.type("old");
  await tool(page, "Strikethrough").click();
  await page.keyboard.type(" and ");
  await tool(page, "Inline code").click();
  await page.keyboard.type("npm test");
  await tool(page, "Inline code").click();
  await page.keyboard.press("Enter");
  await tool(page, "Task list").click();
  await page.keyboard.type("Write the tests");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // an empty item leaves the list
  await tool(page, "Quote").click();
  await page.keyboard.type("Ship it.");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await tool(page, "Code block").click();
  await page.keyboard.type("const x = 1;");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // three Enters leave a code block
  // An image from a file, with alt text. Focus goes back to the text.
  await tool(page, "Image").click();
  const dialog = page.getByRole("dialog", { name: "Insert image" });
  await dialog.getByRole("button", { name: "Insert" }).click();
  await expect(dialog.getByText("Describe the image")).toBeVisible();
  await dialog.getByLabel("Or image file").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG });
  await expect(dialog.getByLabel("Image address")).toBeDisabled(); // the file is used
  await dialog.getByRole("textbox", { name: "Alt text" }).fill("A dot");
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Insert" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(text.locator('img[alt="A dot"]')).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(text).toBeFocused();

  // Cut and paste inside the editor keeps the image, since it passes the same checks as the dialog.
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Control+x");
  await expect(text.locator("img")).toHaveCount(0);
  await page.keyboard.press("Control+v");
  await expect(text.locator('img[alt="A dot"]')).toHaveAttribute("src", /^data:image\/png;base64,/);

  // Pasted HTML keeps an image only when its source passes the dialog's check: a script address or an SVG is dropped.
  await expect(text).toBeFocused();
  await pasteHtml(page, '<p>pasted<img src="javascript:alert(1)" alt="script"><img src="data:image/svg+xml;base64,PHN2Zz4=" alt="svg"></p>');
  await expect(text).toContainText("pasted"); // the paste reached the text
  await expect(text.locator('img[alt="script"], img[alt="svg"]')).toHaveCount(0);

  await page.keyboard.press("Enter");
  await tool(page, "Divider").click();
  await tool(page, "Table").click();
  await page.keyboard.type("Owner");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Task");

  await expect(text.locator("h1")).toHaveText("Plan");
  await expect(text.locator("s")).toHaveText("old");
  await expect(text.locator("p > code")).toHaveText("npm test");
  await expect(text.locator('ul[data-type="taskList"] li > div')).toHaveText("Write the tests");
  await expect(text.locator("blockquote")).toHaveText("Ship it.");
  await expect(text.locator("pre code")).toHaveText("const x = 1;");
  await expect(text.locator("hr")).toHaveCount(1);
  await expect(text.locator("table th").first()).toHaveText("Owner");
  await expect(text.locator("table tr")).toHaveCount(3);

  await expect.poll(() => markdown(id)).toContain("![A dot](data:image/png;base64,");
  const stored = await markdown(id);
  for (const part of ["# Plan", "~~old~~ and `npm test`", "- [ ] Write the tests", "> Ship it.", "```\nconst x = 1;\n```", "| Owner | Task |"]) expect(stored).toContain(part);

  // Undo takes back the last change (the table and the words in it), Redo puts it back.
  await tool(page, "Undo").click();
  await expect(text.locator("table")).toHaveCount(0);
  await tool(page, "Redo").click();
  await expect(text.locator("table")).toContainText("Task");
  await expectAccessible(page);
  await page.context().close();
});

test("an image file that is too big, or that the document has no room for, is refused, also from a paste or a drop", async ({ browser }) => {
  const id = `big-image-${Date.now().toString(36)}`;
  await createClient({ baseUrl: url(), token: ADA }).create({ id, markdown: "Pictures." });
  const page = await newPage(await browser.newContext(), ADA);
  await page.goto(`${url()}/#/d/${id}`);
  const text = textbox(page);
  await text.click();
  await page.keyboard.press("Control+End");
  const dialog = page.getByRole("dialog", { name: "Insert image" });
  const images = text.locator("img:not(.ProseMirror-separator)");
  const insert = async (kb: number) => {
    await tool(page, "Image").click();
    await dialog.getByLabel("Or image file").setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(kb * 1024, 7) });
    await dialog.getByRole("textbox", { name: "Alt text" }).fill("Gray");
    await dialog.getByRole("button", { name: "Insert" }).click();
  };
  const html = (kb: number, alt: string) => `<p><img src="data:image/png;base64,${Buffer.alloc(kb * 1024, 7).toString("base64")}" alt="${alt}"></p>`;
  await insert(200);
  await expect(dialog.getByRole("alert")).toContainText("up to about 180 KB");
  await page.keyboard.press("Escape");
  for (let i = 1; i <= 4; i++) {
    await insert(150); // about 205 KB as text each
    await expect(dialog).toHaveCount(0);
    await expect(images).toHaveCount(i);
  }
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
  await insert(150); // a fifth would pass the document limit
  await expect(dialog.getByRole("alert")).toContainText("no room for this image");
  await page.keyboard.press("Escape");
  await expect(images).toHaveCount(4);

  // A pasted image that does not fit is refused too, and the status line says so until the next change.
  await text.getByText("Pictures.").click();
  await expect(text).toBeFocused();
  await pasteHtml(page, html(150, "pasted"));
  await expect(page.getByRole("status").filter({ hasText: "do not fit" })).toBeVisible();
  await expect(text.locator('img[alt="pasted"]')).toHaveCount(0);
  await page.keyboard.type("more");
  await expect(page.getByRole("status").filter({ hasText: "do not fit" })).toHaveCount(0);

  // A drop that does not fit is refused the same way.
  await page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData("text/html", value);
    const target = document.querySelector(".agd-prose p")!;
    const box = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true, clientX: box.left + 2, clientY: box.top + 2 }));
  }, html(150, "dropped"));
  await expect(page.getByRole("status").filter({ hasText: "do not fit" })).toBeVisible();
  await expect(text.locator('img[alt="dropped"]')).toHaveCount(0);
  await page.context().close();
});

test("the toolbar is one tab stop, and arrow keys move in it", async ({ browser }) => {
  const id = `keys-${Date.now().toString(36)}`;
  await createClient({ baseUrl: url(), token: ADA }).create({ id, markdown: "Some words." });
  const page = await newPage(await browser.newContext(), ADA);
  await page.goto(`${url()}/#/d/${id}`);
  await expect(textbox(page)).toContainText("Some words.");
  // From the last control of the top bar, Tab goes to the toolbar, and a second Tab leaves it for the text.
  await page.getByRole("button", { name: "More actions" }).focus();
  await page.keyboard.press("Tab");
  await expect(tool(page, "Text style: Paragraph")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tool(page, "Bold")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tool(page, "Italic")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(textbox(page)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(tool(page, "Italic")).toBeFocused(); // the toolbar keeps the last tool
  await page.context().close();
});

for (const width of [900, 390]) {
  test(`the caret is scrolled into view below the sticky bar, ${width} px wide`, async ({ browser }) => {
    const id = `scroll-${width}-${Date.now().toString(36)}`;
    await createClient({ baseUrl: url(), token: ADA }).create({ id, markdown: Array.from({ length: 80 }, (_, i) => `Line ${i + 1}.`).join("\n\n") });
    const page = await newPage(await browser.newContext({ viewport: { width, height: 500 } }), ADA);
    await page.goto(`${url()}/#/d/${id}`);
    await textbox(page).click();
    await page.keyboard.press("Control+End");
    for (let i = 0; i < 25; i++) await page.keyboard.press("ArrowUp");
    // The editor reads the caret after the browser moved it, then scrolls, so wait for it to settle.
    await expect
      .poll(() => page.evaluate(() => window.getSelection()!.getRangeAt(0).getBoundingClientRect().top - document.querySelector(".agd-doc__bar")!.getBoundingClientRect().bottom))
      .toBeGreaterThanOrEqual(0);
    await page.context().close();
  });
}
