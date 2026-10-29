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

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("an image gets alt text, or is marked decorative, and both reach the stored document", async ({ browser }) => {
  const ada = await newPage(await browser.newContext(), ADA);
  const id = await createDocument(ada, "Pictures");
  const read = async () => (await fetch(`${url()}/api/v1/docs/${id}/read`, { headers: { authorization: `Bearer ${ADA}` } })).text();
  await textbox(ada).click();

  await expect(ada.getByRole("button", { name: "Image" })).not.toHaveAttribute("aria-pressed", /.*/); // it opens a dialog, so it is not a toggle
  await ada.getByRole("button", { name: "Image" }).click();
  const dialog = ada.getByRole("dialog", { name: "Insert image" });
  await dialog.getByLabel("Image address").fill(PIXEL);
  await dialog.getByRole("button", { name: "Insert" }).click();
  await expect(dialog.getByText("Describe the image")).toBeVisible(); // no alt text and not decorative
  await dialog.getByRole("textbox", { name: "Alt text" }).fill("A red dot");
  await dialog.getByRole("button", { name: "Insert" }).click();
  await expect(textbox(ada).locator("img[src^=data]")).toHaveAttribute("alt", "A red dot");
  await expectAccessible(ada);
  await expect.poll(read).toContain("![A red dot](data:image/png");

  // With the image selected, the same button changes it. The decorative choice writes an empty alt.
  await textbox(ada).locator("img[src^=data]").click();
  await ada.getByRole("button", { name: "Image" }).click();
  const edit = ada.getByRole("dialog", { name: "Image" });
  await expect(edit.getByRole("textbox", { name: "Alt text" })).toHaveValue("A red dot");
  await edit.getByLabel("Decorative image").check();
  await expectAccessible(ada);
  await edit.getByRole("button", { name: "Apply" }).click();
  await expect(textbox(ada).locator("img[src^=data]")).toHaveAttribute("alt", "");
  await expect.poll(read).toContain("![](data:image/png");
  await expectAccessible(ada);

  // An image from Markdown can have a relative source. The dialog still sets its alt text.
  const agent = await LiveDoc.join({ server: url(), id, token: BOT, name: "Scribe" });
  await agent.edit((doc, author) => doc.append("![](images/chart.png)", author));
  await agent.leave();
  const chart = textbox(ada).locator("img[src='images/chart.png']");
  await textbox(ada).click(); // the image has no size, as the file is missing, so the keyboard selects it
  await ada.keyboard.press("Control+End");
  await ada.keyboard.press("Shift+ArrowLeft");
  await ada.getByRole("button", { name: "Image" }).click();
  await ada.getByLabel("Decorative image").uncheck(); // an empty alt reads as decorative
  await ada.getByRole("textbox", { name: "Alt text" }).fill("Sales chart");
  await ada.getByRole("button", { name: "Apply" }).click();
  await expect(chart).toHaveAttribute("alt", "Sales chart");
  await ada.context().close();
});

test("the share dialog lists, changes, and removes roles, invites, and makes a link, for an owner only", async ({ browser }) => {
  const ada = await newPage(await browser.newContext(), ADA);
  const id = await createDocument(ada, "Shared plan");
  const sdk = createClient({ baseUrl: url(), token: ADA });
  await sdk.grant(id, { to: "human:Bob", role: "editor" });

  await ada.getByRole("button", { name: "Share" }).click();
  const dialog = ada.getByRole("dialog", { name: "Share document" });
  await expect(dialog).not.toContainText("not available yet");
  await expect(dialog.getByRole("combobox", { name: "Role for Ada" })).toHaveValue("owner");
  await expect(dialog.getByRole("combobox", { name: "Role for Bob" })).toHaveValue("editor");

  await dialog.getByRole("combobox", { name: "Role for Bob" }).selectOption("viewer");
  await expect(dialog.getByRole("status").filter({ hasText: "Bob is now viewer." })).toBeVisible();
  await expect(dialog).toContainText("reads and writes do not check them yet");
  expect((await sdk.grants(id)).find((g) => g.subjectId === "Bob")?.role).toBe("viewer");

  await dialog.getByLabel("Invite by email or @handle").fill("nobody");
  await dialog.getByRole("button", { name: "Invite" }).click();
  await expect(dialog.getByRole("alert")).toContainText("email address");
  await dialog.getByLabel("Invite by email or @handle").fill("kit@example.com");
  await dialog.getByRole("button", { name: "Invite" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Invite made" })).toBeVisible();
  await dialog.getByLabel("Invite by email or @handle").fill("@Helper"); // the handle is lower-cased, as the server needs
  await dialog.getByRole("button", { name: "Invite" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Invite made for @helper" })).toBeVisible();
  expect((await sdk.invites(id)).map((i) => `${i.for}:${i.handle ?? ""}`).sort()).toEqual(["email:", "handle:helper"]);

  await dialog.getByRole("button", { name: "Make a link" }).click();
  const token = dialog.getByLabel("Link token (shows once)");
  await expect(token).toBeVisible();
  expect((await token.inputValue()).length).toBeGreaterThanOrEqual(32);
  await expectAccessible(ada);
  await dialog.getByRole("button", { name: "Revoke link" }).click();
  await expect(token).toHaveCount(0);

  await dialog.getByRole("button", { name: "Remove Bob" }).click();
  await expect(dialog.getByRole("combobox", { name: "Role for Bob" })).toHaveCount(0);
  expect((await sdk.grants(id)).map((g) => g.subjectId)).toEqual(["Ada"]);

  // Bob is not an owner. The server refuses him, and the dialog shows no controls.
  const bob = await newPage(await browser.newContext(), BOB);
  await bob.goto(`${url()}/#/d/${id}`);
  await bob.getByRole("button", { name: "Share" }).click();
  const other = bob.getByRole("dialog", { name: "Share document" });
  await expect(other.getByText("Only an owner can see or change who has access.")).toBeVisible();
  await expect(other.getByRole("button", { name: "Invite" })).toHaveCount(0);
  await expectAccessible(bob);
  await bob.context().close();
  await ada.context().close();
});

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
  await expect(ada.getByRole("dialog")).toHaveCount(0);
  await expect(textbox(ada)).toBeFocused(); // writing goes on in the text after the dialog closes
  await ada.keyboard.press("Control+End"); // the caret goes to the end of the text, whatever is selected
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

test("deleting from the editor stays deleted, and a bad edit log entry does not blank the page", async ({ page, browser }) => {
  const violations: string[] = [];
  page.on("console", (m) => /content security policy|refused to/i.test(m.text()) && violations.push(m.text()));
  expect((await fetch(url())).headers.get("content-security-policy")).toContain("img-src 'self' data:");
  await signIn(page, ADA);
  const id = await createDocument(page, "Short lived");
  await textbox(page).click();
  await page.keyboard.type("Gone soon.");

  // Another peer puts junk in the edit log. The room does not check the log.
  const peer = await LiveDoc.join({ server: url(), id, token: BOB });
  peer.doc.ydoc.transact(() => peer.doc.ydoc.getArray("edits").push([null as never]));
  await peer.flush();
  await peer.leave();
  await expect(textbox(page)).toContainText("Gone soon.");

  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeFocused();
  await page.waitForTimeout(3000); // longer than the save delay
  const read = await fetch(`${url()}/api/v1/docs/${id}/read`, { headers: { authorization: `Bearer ${ADA}` } });
  expect(read.status).toBe(404);
  expect(violations).toEqual([]);
  void browser;
});

test("a document that someone else deleted stays deleted when this tab saves or leaves", async ({ browser }) => {
  const id = `doomed-${Date.now().toString(36)}`;
  const ada = createClient({ baseUrl: url(), token: ADA });
  await ada.create({ id, markdown: "Hello." });
  const bob = await newPage(await browser.newContext(), BOB);
  await bob.goto(`${url()}/#/d/${id}`);
  await expect(textbox(bob)).toContainText("Hello.");
  await textbox(bob).click();
  await bob.keyboard.type(" Typed after the delete.");
  await ada.remove(id);
  // Bob's typing save finds no document and says so. It does not make the document again.
  await bob.keyboard.type(" More.");
  await expect(bob.getByRole("status").filter({ hasText: "was removed" })).toBeVisible();
  await bob.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(bob.getByRole("heading", { name: "Documents", level: 1 })).toBeVisible();
  await bob.waitForTimeout(1000);
  expect((await fetch(`${url()}/api/v1/docs/${id}/read`, { headers: { authorization: `Bearer ${ADA}` } })).status).toBe(404);
  expect((await ada.list()).map((d) => d.id)).not.toContain(id);
  await bob.context().close();
});

test("opening a document and leaving it does not change who edited it last", async ({ browser }) => {
  const id = `quiet-${Date.now().toString(36)}`;
  await createClient({ baseUrl: url(), token: BOB }).create({ id, markdown: "Bob wrote this." });
  const ada = await newPage(await browser.newContext(), ADA);
  await ada.goto(`${url()}/#/d/${id}`);
  await expect(textbox(ada)).toContainText("Bob wrote this.");
  await ada.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(ada.getByRole("link", { name: id })).toBeVisible();
  const row = (await createClient({ baseUrl: url(), token: ADA }).list()).find((d) => d.id === id)!;
  expect(row.updatedBy).toEqual({ kind: "human", name: "Bob" });
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
  await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeFocused(); // focus is not lost when the list refreshes

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
  await expectAccessible(vic);
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
    await expect(page.locator(".agd-stack__summary")).toContainText("1 agent");
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
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Image" }).click();
    await expect(page.getByRole("dialog", { name: "Insert image" })).toBeVisible();
    await page.getByRole("button", { name: "Insert" }).click(); // empty fields show their errors
    await expect(page.getByText("Describe the image")).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    for (const [open, dialog] of [["Rename", "Rename document"], ["Delete", "Delete document"]]) {
      await page.getByRole("button", { name: open, exact: true }).click();
      await expect(page.getByRole("dialog", { name: dialog })).toBeVisible();
      await expectAccessible(page);
      await page.keyboard.press("Escape");
    }
    await page.goto(`${url()}/#/`);
    await expect(page.getByRole("link", { name: "Quarterly plan" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Actions for Quarterly plan" }).first().click();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await agent.leave();
    await bob.context().close();
    await context.close();
  });
}
