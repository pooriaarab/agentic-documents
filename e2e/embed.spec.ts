import { expect, test, type Browser, type Page } from "@playwright/test";
import { createClient } from "../src/client.js";
import { AgenticDoc } from "../src/doc.js";
import { exportFile, importFile } from "../src/formats.js";
import { ADA, BOB, BOT, VIC } from "./tokens.js";
import { expectAccessible, url } from "./helpers.js";

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
  await expect(ada.locator(".caret__tag")).toHaveText("Bob");

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
  await expect(ada.locator(".ad-stack__summary")).toContainText("1 agent");
  // Text the agent types in its embedded editor is marked as agent work for the person.
  await typeAtEnd(bot, " Agent line.");
  await expect(textbox(ada).locator(".agent-text", { hasText: "Agent line." })).toHaveCount(1);
  await expect(textbox(ada).locator(".agent-text", { hasText: "Shared" })).toHaveCount(0);
  const vic = await host(browser, VIC, id);
  await expect(textbox(vic)).toHaveAttribute("contenteditable", "false");
  await expect(vic.getByText(/Read only\./)).toBeVisible();
  await expect(vic.getByRole("button", { name: "Bold" })).toBeDisabled();
  for (const page of [ada, bot, vic]) await page.context().close();
});

test("without a room the embedded editor still saves through the client", async ({ browser }) => {
  const id = `embed-solo-${Date.now()}`;
  await sdk(ADA).create({ id, markdown: "Alone." });
  const ada = await host(browser, ADA, id, "&solo");
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
