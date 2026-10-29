import { expect, test, type Browser, type Page } from "@playwright/test";
import { createClient } from "../src/client.js";
import { ADA, BOB, BOT, VIC } from "./tokens.js";
import { expectAccessible, url } from "./helpers.js";

// The host page in e2e/embed/host.ts keeps the document in its own Yjs room and gives it to the editor as `host`.
const textbox = (page: Page) => page.getByRole("textbox", { name: "Document text" });
const sdk = (token: string) => createClient({ baseUrl: url(), token });
const call = <T>(page: Page, name: string) => page.evaluate((fn) => (window as unknown as Record<string, () => T>)[fn](), name);

async function host(browser: Browser, token: string, id: string, who: { kind: string; name: string; role?: string }): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  const hash = new URLSearchParams({ token, id, kind: who.kind, name: who.name, ...(who.role ? { role: who.role } : {}) });
  await page.goto(`${url()}/embed/host.html#${hash}`);
  await expect(textbox(page)).toBeVisible();
  return page;
}

async function typeAtEnd(page: Page, text: string) {
  await textbox(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

test("two host apps co-edit their own room's document through the editor, see each other, and keep the document after unmount", async ({ browser }) => {
  const id = `host-${Date.now()}`;
  await sdk(ADA).create({ id, markdown: "# Hosted\n\nStart." });
  const ada = await host(browser, ADA, id, { kind: "human", name: "Ada" });
  const bob = await host(browser, BOB, id, { kind: "human", name: "Bob" });
  await expect(textbox(ada)).toContainText("Start.");

  await typeAtEnd(ada, " Ada wrote this.");
  await expect(textbox(bob)).toContainText("Ada wrote this.");
  await typeAtEnd(bob, " Bob wrote this.");
  await expect(textbox(ada)).toContainText("Bob wrote this.");
  await expect(ada.getByText("2 people")).toBeVisible();
  await expect(ada.locator(".caret__tag")).toHaveText("Bob");
  // The host keeps the document, so the editor shows no save state of its own.
  await expect(ada.getByText(/Saved|Saving/)).toHaveCount(0);
  await expectAccessible(ada);
  expect(await call<number>(ada, "editorsSeen")).toBe(1);

  // The editor goes. The host's document and room stay, and still get Bob's edits.
  await ada.evaluate(() => (window as unknown as { unmountEditor: () => Promise<void> }).unmountEditor());
  await expect(ada.getByRole("textbox")).toHaveCount(0);
  expect(await call<string>(ada, "hostStatus")).toBe("connected");
  await typeAtEnd(bob, " After.");
  await expect.poll(() => call<string>(ada, "hostText")).toContain("Bob wrote this. After.");
  await ada.context().close();
  await bob.context().close();
});

test("on a host document an agent shows as an agent, its text is marked, and a viewer reads only", async ({ browser }) => {
  const id = `host-roles-${Date.now()}`;
  await sdk(ADA).create({ id, markdown: "Shared text." });
  const ada = await host(browser, ADA, id, { kind: "human", name: "Ada" });
  const bot = await host(browser, BOT, id, { kind: "agent_of_human", name: "Scribe" });
  await expect(ada.locator(".ad-stack__summary")).toContainText("1 agent");
  await typeAtEnd(bot, " Agent line.");
  await expect(textbox(ada).locator(".agent-text", { hasText: "Agent line." })).toHaveCount(1);
  await expect(textbox(ada).locator(".agent-text", { hasText: "Shared" })).toHaveCount(0);
  const vic = await host(browser, VIC, id, { kind: "human", name: "Vic", role: "viewer" });
  await expect(textbox(vic)).toHaveAttribute("contenteditable", "false");
  await expect(vic.getByText(/Read only\./)).toBeVisible();
  await expectAccessible(vic);
  for (const page of [ada, bot, vic]) await page.context().close();
});
