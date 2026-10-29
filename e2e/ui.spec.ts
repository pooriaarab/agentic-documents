import { expect, test, type Page } from "@playwright/test";
import { LiveDoc } from "../src/live.js";
import { createClient } from "../src/client.js";
import { ADA, BOB, BOT, VIC } from "./tokens.js";
import { expectAccessible, newPage, shoot, signIn, themes, url } from "./helpers.js";

const textbox = (page: Page) => page.getByRole("textbox", { name: "Document text" });
const idOf = (page: Page) => decodeURIComponent(new URL(page.url()).hash.replace("#/d/", ""));

async function createDocument(page: Page, title: string): Promise<string> {
  await page.getByRole("button", { name: "New document" }).first().click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeFocused(); // a new view moves focus to its heading
  await expect(textbox(page)).toBeVisible();
  return idOf(page);
}

test("create a document, type, reload, and a second browser sees the edit live", async ({ browser }) => {
  const ada = await newPage(await browser.newContext(), ADA);
  const id = await createDocument(ada, "Weekly plan");
  await textbox(ada).click();

  await ada.keyboard.type("Ship on Friday. ");
  await ada.keyboard.press("Control+b");
  await ada.keyboard.type("Bold part");
  await ada.keyboard.press("Control+b");
  await ada.keyboard.type(" see docs");
  await ada.keyboard.press("Control+Shift+ArrowLeft");
  await ada.getByRole("button", { name: "Link" }).click();
  await ada.getByLabel("Address").fill("https://example.com/docs");
  await ada.getByRole("button", { name: "Apply" }).click();
  await ada.keyboard.press("End");
  await ada.keyboard.press("Enter");
  await ada.getByRole("button", { name: "H2 heading" }).click();
  await ada.keyboard.type("Risks");
  await ada.keyboard.press("Enter");
  await ada.getByRole("button", { name: "Bulleted list" }).click();
  await ada.keyboard.type("Late review");
  await ada.keyboard.press("Enter");
  await ada.keyboard.press("Control+i");
  await ada.keyboard.type("Slow build");

  await expect(textbox(ada).locator("strong")).toHaveText("Bold part");
  await expect(textbox(ada).locator("em")).toHaveText("Slow build");
  await expect(textbox(ada).locator("a")).toHaveAttribute("href", "https://example.com/docs");
  await expect(textbox(ada).locator("h2")).toHaveText("Risks");
  await expect(textbox(ada).locator("ul li")).toHaveCount(2);

  // The page saves to the stored document, so an HTTP read sees it.
  await expect
    .poll(async () => (await fetch(`${url()}/api/v1/docs/${id}/read`, { headers: { authorization: `Bearer ${ADA}` } })).text())
    .toContain("Ship on Friday.");

  await ada.reload();
  await expect(textbox(ada)).toContainText("Ship on Friday.");
  await expect(textbox(ada).locator("h2")).toHaveText("Risks");

  // A second person opens the same document and sees it, then types.
  const bob = await newPage(await browser.newContext(), BOB);
  await bob.goto(`${url()}/#/d/${id}`);
  await expect(textbox(bob)).toContainText("Ship on Friday.");
  await textbox(bob).click();
  await bob.keyboard.press("Control+End");
  await bob.keyboard.type(" Bob was here.");
  await expect(textbox(ada)).toContainText("Bob was here.");
  await expect(ada.getByText("2 people")).toBeVisible(); // Ada and Bob are both in the room
  await bob.context().close();
  await ada.context().close();
});

test("text an agent wrote is marked, and the agent shows as an agent", async ({ browser }) => {
  const id = `agent-notes-${Date.now().toString(36)}`;
  await createClient({ baseUrl: url(), token: ADA }).create({ id, markdown: "# Notes\n\nPerson text." });
  const ada = await newPage(await browser.newContext(), ADA);
  await ada.goto(`${url()}/#/d/${id}`);
  await expect(textbox(ada)).toContainText("Person text.");
  await expect(textbox(ada).locator(".agent-text")).toHaveCount(0);

  const agent = await LiveDoc.join({ server: url(), id, token: BOT, name: "Scribe" });
  await agent.edit((doc, author) => doc.append("Agent paragraph.", author));
  await agent.save();
  await expect(textbox(ada)).toContainText("Agent paragraph.");
  await expect(textbox(ada).locator(".agent-text")).toContainText("Agent paragraph.");
  await expect(textbox(ada).locator(".agent-text")).not.toContainText("Person text.");
  await expect(ada.getByText("Dotted text was written by an agent.")).toBeVisible();
  await expect(ada.getByText(/1 agent/)).toBeVisible();
  await agent.leave();

  // The mark comes from the document, so it is still there after a reload.
  await ada.reload();
  await expect(textbox(ada).locator(".agent-text")).toContainText("Agent paragraph.");
  await ada.context().close();
});

test("rename and delete from the list, with the keyboard", async ({ page }) => {
  await signIn(page, ADA);
  const title = `Draft ${Date.now().toString(36)}`;
  await createDocument(page, title);
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeFocused();
  await expect(page.getByRole("link", { name: title })).toBeVisible();

  await page.getByRole("button", { name: `Actions for ${title}` }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Rename" }).press("Enter");
  await page.getByLabel("Title").fill(`${title} v2`);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: `${title} v2` })).toBeVisible();

  await page.getByRole("button", { name: `Actions for ${title} v2` }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Delete" }).press("Enter");
  await expect(page.getByRole("dialog", { name: "Delete document" })).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("link", { name: `${title} v2` })).toHaveCount(0);
});

test("the first tab stop skips to the content, and a focused control shows a ring", async ({ page }) => {
  await signIn(page, ADA);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /skip/i })).toBeFocused();
  const button = page.getByRole("button", { name: "Sign out" });
  for (let i = 0; i < 12 && !(await button.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  const ring = await button.evaluate((e) => {
    const style = getComputedStyle(e);
    return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "outline" : style.boxShadow !== "none" ? "shadow" : "none";
  });
  expect(ring).not.toBe("none");
});

test("loading, empty, and error states, and a missing document", async ({ page }) => {
  await signIn(page, ADA);
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/docs", async (route) => {
    await gate;
    await route.fulfill({ json: [] });
  });
  await page.reload();
  await expect(page.getByText("Loading documents…")).toBeVisible();
  release();
  await expect(page.getByText("No documents yet")).toBeVisible();
  await page.unroute("**/api/v1/docs");

  await page.route("**/api/v1/docs", (route) => route.fulfill({ status: 500, json: { error: { code: "INTERNAL", message: "the server could not finish the request", matches: [] } } }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Could not load documents");
  await page.unroute("**/api/v1/docs");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.goto(`${url()}/#/d/no-such-doc`);
  await expect(page.getByRole("alert")).toContainText("does not exist");
  await page.getByRole("button", { name: "Back to documents" }).click();
  await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeVisible();
});

test("a bad token is refused, and a viewer can read but not write", async ({ page, browser }) => {
  await page.goto(url());
  await page.getByLabel("Access token").fill(`nobody-${"n".repeat(40)}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("The server did not accept this token.")).toBeVisible();

  const id = `viewer-doc-${Date.now().toString(36)}`;
  await createClient({ baseUrl: url(), token: ADA }).create({ id, markdown: "Read me." });
  const vic = await newPage(await browser.newContext(), VIC);
  await expect(vic.getByRole("button", { name: "New document" })).toHaveCount(0);
  await vic.goto(`${url()}/#/d/${id}`);
  await expect(textbox(vic)).toContainText("Read me.");
  await expect(textbox(vic)).toHaveAttribute("contenteditable", "false");
  await expect(vic.getByRole("status").filter({ hasText: "Read only" })).toBeVisible();
  await expect(vic.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await vic.context().close();
});

for (const theme of themes) {
  test(`every view meets WCAG 2.2 AA in the ${theme} theme, and the screenshots`, async ({ browser }) => {
    const id = `shots-${theme}-${Date.now().toString(36)}`;
    const ada = createClient({ baseUrl: url(), token: ADA });
    await ada.create({ id, markdown: "# Quarterly plan\n\nShip the editor on Friday. See the [roadmap](https://example.com).\n\n- Review the draft\n- Send it out" });
    await ada.rename(id, { title: "Quarterly plan" });
    const context = await browser.newContext({ colorScheme: theme, viewport: { width: 1100, height: 760 } });
    const signedOut = await context.newPage();
    await signedOut.goto(url());
    await expect(signedOut.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expectAccessible(signedOut);
    await shoot(signedOut, "sign-in", theme);

    const page = await newPage(context, ADA);
    await expect(page.getByRole("link", { name: "Quarterly plan" }).first()).toBeVisible();
    await expectAccessible(page);
    await shoot(page, "list", theme);
    await page.getByRole("button", { name: "New document" }).first().click();
    await expect(page.getByRole("dialog", { name: "New document" })).toBeVisible();
    await expectAccessible(page);
    await shoot(page, "new-document", theme);
    await page.keyboard.press("Escape");

    // The empty and the error list, with the server answers stubbed.
    await page.route("**/api/v1/docs", (route) => route.fulfill({ json: [] }));
    await page.reload();
    await expect(page.getByText("No documents yet")).toBeVisible();
    await expectAccessible(page);
    await shoot(page, "list-empty", theme);
    await page.route("**/api/v1/docs", (route) => route.fulfill({ status: 500, json: { error: { code: "INTERNAL", message: "the server could not finish the request", matches: [] } } }));
    await page.reload();
    await expect(page.getByRole("alert")).toBeVisible();
    await expectAccessible(page);
    await shoot(page, "list-error", theme);
    await page.unroute("**/api/v1/docs");

    // The editor, with a second person and an agent in the room.
    const bob = await newPage(await browser.newContext(), BOB);
    await bob.goto(`${url()}/#/d/${id}`);
    await expect(textbox(bob)).toContainText("Ship the editor");
    const agent = await LiveDoc.join({ server: url(), id, token: BOT, name: "Scribe" });
    await agent.edit((doc, author) => doc.append("Agent note: the roadmap needs a date.", author));
    await agent.save();
    await page.goto(`${url()}/#/d/${id}`);
    await page.reload();
    await expect(textbox(page)).toContainText("Agent note");
    await expect(textbox(page).locator(".agent-text")).toContainText("Agent note");
    await expect(page.locator(".ad-stack__summary")).toContainText("1 agent");
    await textbox(page).click();
    await expectAccessible(page);
    await shoot(page, "editor", theme);

    await page.getByRole("button", { name: "Share" }).click();
    await expect(page.getByRole("dialog", { name: "Share document" })).toBeVisible();
    await expect(page.getByText("Loading…")).toHaveCount(0);
    await expectAccessible(page);
    await shoot(page, "share", theme);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Link" }).click();
    await expect(page.getByRole("dialog", { name: "Link" })).toBeVisible();
    await expectAccessible(page);
    await agent.leave();
    await bob.context().close();
    await context.close();
  });
}
