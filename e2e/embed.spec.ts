import { expect, test, type Browser, type Page } from "@playwright/test";
import { createClient } from "../src/client.js";
import { AgenticDoc } from "../src/doc.js";
import { exportFile, importFile } from "../src/formats.js";
import { ADA, BOB, BOT, VIC } from "./tokens.js";
import { expectAccessible, pasteHtml, url } from "./helpers.js";

// The host page in e2e/embed mounts `agentic-documents/ui` from the build, with a client and a live room.
const textbox = (page: Page) => page.getByRole("textbox", { name: "Document text" });
const sdk = (token: string) => createClient({ baseUrl: url(), token });

async function host(browser: Browser, token: string, id: string, extra = ""): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${url()}/embed/#token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}${extra}`);
  await expect(textbox(page)).toBeVisible();
  return page;
}

async function typeAtEnd(page: Page, text: string) {
  await textbox(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

test("two host pages co-edit one document through the embedded editor, and the saved text exports and imports back", async ({ browser }) => {
  const id = `embed-${Date.now()}`;
  await sdk(ADA).create({ id, markdown: "# Embedded\n\nStart." });
  const ada = await host(browser, ADA, id);
  const bob = await host(browser, BOB, id);
  await expect(textbox(ada)).toContainText("Start.");

  await typeAtEnd(ada, " Ada wrote this.");
  await expect(textbox(bob)).toContainText("Ada wrote this.");
  await typeAtEnd(bob, " Bob wrote this.");
  await expect(textbox(ada)).toContainText("Bob wrote this.");
  await expect(ada.getByText("2 people")).toBeVisible();
  await expect(ada.locator(".agd-caret__tag")).toHaveText("Bob");

  // Unmounting saves this tab's changes to the stored document.
  await ada.evaluate(() => (window as unknown as { unmountEditor: () => void }).unmountEditor());
  await bob.evaluate(() => (window as unknown as { unmountEditor: () => void }).unmountEditor());
  await expect(ada.getByRole("textbox")).toHaveCount(0);
  await expect.poll(async () => AgenticDoc.fromUpdate(await sdk(ADA).state(id)).toMarkdown()).toContain("Bob wrote this.");

  const saved = AgenticDoc.fromUpdate(await sdk(ADA).state(id));
  expect(saved.toMarkdown()).toBe("# Embedded\n\nStart. Ada wrote this. Bob wrote this.\n");
  for (const format of ["md", "odt", "docx"] as const) {
    const back = importFile(exportFile(saved, format).data, format, { kind: "human", name: "Ada" });
    expect(back.doc.toMarkdown()).toBe(saved.toMarkdown());
  }
  // The Worker's own ODT export reads back through the same mapping.
  expect(importFile(await sdk(ADA).export(id, { format: "odt" }), "odt", { kind: "human", name: "Ada" }).doc.toMarkdown()).toBe(saved.toMarkdown());
  await ada.context().close();
  await bob.context().close();
});

test("an agent in the room shows as an agent, its typed text is marked, and a viewer token opens the text read only", async ({ browser }) => {
  const id = `embed-roles-${Date.now()}`;
  await sdk(ADA).create({ id, markdown: "Shared text." });
  const ada = await host(browser, ADA, id);
  const bot = await host(browser, BOT, id);
  await expect(ada.locator(".agd-stack__summary")).toContainText("1 agent");
  // Text the agent types in its embedded editor is marked as agent work for the person.
  await typeAtEnd(bot, " Agent line.");
  await expect(textbox(ada).locator(".agd-agent-text", { hasText: "Agent line." })).toHaveCount(1);
  await expect(textbox(ada).locator(".agd-agent-text", { hasText: "Shared" })).toHaveCount(0);
  const vic = await host(browser, VIC, id);
  await expect(textbox(vic)).toHaveAttribute("contenteditable", "false");
  await expect(vic.getByText(/Read only\./)).toBeVisible();
  await expect(vic.getByRole("button", { name: "Bold" })).toBeDisabled();
  for (const page of [ada, bot, vic]) await page.context().close();
});

test("without a room the embedded editor still saves through the client", async ({ browser }) => {
  const id = `embed-noroom-${Date.now()}`;
  await sdk(ADA).create({ id, markdown: "Alone." });
  const ada = await host(browser, ADA, id, "&noroom");
  await typeAtEnd(ada, " Still saved.");
  await expect(ada.getByText("Saved", { exact: true })).toBeVisible();
  await expect.poll(async () => sdk(ADA).read(id)).toContain("Alone. Still saved.");
  await expectAccessible(ada);
  await ada.context().close();
});

test("a missing document shows an error in the host page", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${url()}/embed/#token=${ADA}&id=no-such-embed`);
  await expect(page.getByRole("alert")).toContainText("does not exist");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.context().close();
});

test("the embedded editor takes an image from a web address or a file, a chosen file can be removed, and a paste is checked", async ({ browser }) => {
  const id = `embed-image-${Date.now()}`;
  await sdk(ADA).create({ id, markdown: "Picture below." });
  const ada = await host(browser, ADA, id);
  await expect(textbox(ada)).toContainText("Picture below.");
  await typeAtEnd(ada, " ");
  await ada.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Image", exact: true }).click();
  const dialog = ada.getByRole("dialog", { name: "Insert image" });
  const address = dialog.getByLabel("Image address");

  await dialog.getByLabel("Or image file").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: Buffer.from("x") });
  await expect(address).toBeDisabled();
  await dialog.getByRole("button", { name: "Remove file" }).click();
  await expect(address).toBeEnabled();
  expect(await dialog.getByLabel("Or image file").inputValue()).toBe("");

  await address.fill("https://example.com/a.png");
  await dialog.getByRole("textbox", { name: "Alt text" }).fill("A chart");
  await expectAccessible(ada);
  await dialog.getByRole("button", { name: "Insert" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(textbox(ada).locator('img[alt="A chart"]')).toHaveAttribute("src", "https://example.com/a.png");

  // Pasted HTML keeps an image whose source passes the dialog's check, and drops a script address. The paste goes to the
  // focused element, so wait for the focus to come back to the text after the dialog.
  await expect(textbox(ada)).toBeFocused();
  await pasteHtml(ada, '<p>y<img src="https://example.com/b.png" alt="kept"><img src="javascript:alert(1)" alt="dropped"></p>');
  await expect(textbox(ada).locator('img[alt="kept"]')).toHaveCount(1);
  await expect(textbox(ada).locator('img[alt="dropped"]')).toHaveCount(0);
  await ada.context().close();
});

test("a host adds a slash item, a bubble tool, and a Tiptap extension, and one that adds a mark is refused", async ({ browser }) => {
  const id = `embed-extras-${Date.now()}`;
  await sdk(ADA).create({ id, markdown: "Shared plan for the week." });
  const ada = await host(browser, ADA, id, "&extras");
  await typeAtEnd(ada, " ");
  await ada.keyboard.type("/sign");
  await ada.getByRole("listbox", { name: "Insert a block" }).getByRole("option", { name: /^Signature/ }).click();
  await expect(textbox(ada)).toContainText("Signed, the host");
  await ada.keyboard.press("Control+Shift+y");
  expect(await ada.evaluate(() => (window as unknown as { seen: { shortcut?: boolean } }).seen.shortcut)).toBe(true);

  // The host's tool comes after the built-in ones, and runs with the selection in place. Alt+F10 reaches it.
  await ada.keyboard.press("Shift+Home");
  const bubble = ada.getByRole("toolbar", { name: "Selection" });
  await expect(bubble.getByRole("button", { name: "Comment" })).toBeVisible();
  await ada.keyboard.press("Alt+F10");
  await ada.keyboard.press("End"); // the last tool of the toolbar
  await expect(bubble.getByRole("button", { name: "Comment" })).toBeFocused();
  await ada.keyboard.press("Enter");
  expect(await ada.evaluate(() => (window as unknown as { seen: { comment?: string } }).seen.comment)).toContain("Signed, the host");
  await expect(textbox(ada)).toBeFocused(); // a host tool gives the focus back to the text, as the built-in ones do

  // A viewer gets no bubble menu, and the host cannot replace a read-only editor's text.
  const vic = await host(browser, VIC, id, "&extras");
  await expect(textbox(vic)).toContainText("Shared plan");
  await textbox(vic).dblclick();
  await expect(vic.getByRole("toolbar", { name: "Selection" })).toHaveCount(0);
  expect(await vic.evaluate(() => (window as unknown as { tryImport: () => string }).tryImport())).toContain("read only");

  // A host extension that adds a mark, or an attribute to a node, stops the editor with a message that names them, rather
  // than writing what the store cannot keep.
  const bad = await (await browser.newContext()).newPage();
  await bad.goto(`${url()}/embed/#token=${encodeURIComponent(ADA)}&id=${encodeURIComponent(id)}&extras&badext`);
  await expect(bad.getByRole("alert")).toContainText("The editor stopped");
  await expect(bad.getByRole("alert")).toContainText("paragraph, image, hostHighlight"); // the message names what it refused
  await expect(bad.getByRole("textbox")).toHaveCount(0);
  expect(await bad.evaluate(() => (window as unknown as { seen: { error?: string } }).seen.error)).toContain("hostHighlight");
  // A refused extension must leave its room. A new peer sees Ada, Vic, and itself, without the failed editor.
  const observer = await host(browser, ADA, id);
  await expect(observer.getByText("3 people", { exact: true })).toBeVisible();
  await ada.context().close();
  await vic.context().close();
  await bad.context().close();
  await observer.context().close();
});

for (const property of ["excludes", "inclusive"]) {
  test(`a host cannot change an inline-code mark's ${property} rule`, async ({ browser }) => {
    const id = `embed-mark-${property}-${Date.now()}`;
    await sdk(ADA).create({ id, markdown: "Shared plan." });
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${url()}/embed/#token=${encodeURIComponent(ADA)}&id=${id}&extras&badmark=${property}`);
    await expect(page.getByRole("alert")).toContainText("it adds or changes code");
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await page.context().close();
  });
}
