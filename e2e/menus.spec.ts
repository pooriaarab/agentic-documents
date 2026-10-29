import { expect, test, type Page } from "@playwright/test";
import { createClient } from "../src/client.js";
import { LiveDoc } from "../src/live.js";
import { ADA, BOB, VIC } from "./tokens.js";
import { expectAccessible, newPage, shoot, themes, url } from "./helpers.js";

const textbox = (page: Page) => page.getByRole("textbox", { name: "Document text" });

async function open(browser: import("@playwright/test").Browser, markdown: string, token = ADA) {
  const id = `menus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await createClient({ baseUrl: url(), token: ADA }).create({ id, markdown });
  const page = await newPage(await browser.newContext(), token);
  await page.goto(`${url()}/#/d/${id}`);
  return { page, id };
}

test("the slash menu filters, moves with the arrow keys, and puts in the block", async ({ browser }) => {
  const { page } = await open(browser, "");
  const text = textbox(page);
  await expect(text.locator("p[data-placeholder]")).toHaveAttribute("data-placeholder", "Write, or type / to add a block");
  await text.click();
  await page.keyboard.type("/");
  const list = page.getByRole("listbox", { name: "Insert a block" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option")).toHaveCount(12);
  await expect(list.getByRole("option", { name: /^Text/ })).toHaveAttribute("aria-selected", "true");
  await expect(text).toHaveAttribute("aria-controls", (await list.getAttribute("id"))!);
  await expect(text).toBeFocused(); // the text keeps the focus
  await expectAccessible(page);

  await page.keyboard.type("head");
  await expect(list.getByRole("option")).toHaveCount(3);
  await page.keyboard.press("ArrowDown");
  const second = list.getByRole("option", { name: /^Heading 2/ });
  await expect(second).toHaveAttribute("aria-selected", "true");
  await expect(text).toHaveAttribute("aria-activedescendant", (await second.getAttribute("id"))!);
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(text).not.toHaveAttribute("aria-activedescendant", /./);
  await page.keyboard.type("Risks");
  await expect(text.locator("h2")).toHaveText("Risks"); // the slash and the word are gone
  await page.keyboard.press("Enter");

  // Escape closes the menu, and it stays closed while that slash is there.
  await page.keyboard.type("1/2");
  await expect(list).toHaveCount(0); // a slash inside a word is not a command
  await page.keyboard.type(" /");
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight"); // away and back: it stays closed
  await expect(list).toHaveCount(0);
  await page.keyboard.type("x");
  await expect(list).toHaveCount(0);
  await expect(text.locator("p", { hasText: "1/2" })).toHaveText("1/2 /x");
  await page.keyboard.press("Enter");

  // A pick with the pointer.
  await page.keyboard.type("/tab");
  await list.getByRole("option", { name: /^Table/ }).click();
  await expect(text.locator("table tr")).toHaveCount(3);
  await page.keyboard.type("Owner");
  await expect(text.locator("table th").first()).toHaveText("Owner");

  // A word that finds nothing shows no menu, and Enter makes a new line as usual.
  await page.keyboard.press("Control+End");
  await page.keyboard.type("/zzz");
  await expect(list).toHaveCount(0);
  const lines = await text.locator("p").count();
  await page.keyboard.press("Enter");
  await expect(text.locator("p")).toHaveCount(lines + 1);

  // A slash that Escape closed, then deleted, and typed again in the same place opens the menu again.
  await page.keyboard.type("/");
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/");
  await expect(list).toBeVisible();
  await expect(text).toHaveAttribute("aria-keyshortcuts", "Alt+F10");

  // After a closed slash, a new slash later on the same line opens the menu.
  await page.keyboard.press("Escape");
  await page.keyboard.type("t and /");
  await expect(list).toBeVisible();
  await page.context().close();
});

test("on a short window the slash menu shows a part of the list, and the arrow keys reach the rest", async ({ browser }) => {
  const { page } = await open(browser, "");
  await page.setViewportSize({ width: 800, height: 420 });
  await textbox(page).click();
  await page.keyboard.type("/");
  const list = page.getByRole("listbox", { name: "Insert a block" });
  await expect(list).toBeVisible();
  expect(await list.getByRole("option").count()).toBeLessThan(12);
  await expect(page.getByText(/more: use the arrow keys/)).toBeVisible();
  await page.keyboard.press("ArrowUp"); // from the first item to the last
  await expect(list.getByRole("option", { name: /^Image/ })).toHaveAttribute("aria-selected", "true");
  await expect(list.getByRole("option", { name: /^Image/ })).toHaveAttribute("aria-posinset", "12");
  await expect(list.getByRole("option", { name: /^Text/ })).toHaveCount(0);
  const box = (await page.locator(".agd-slash").boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(420);
  await expectAccessible(page);
  await page.context().close();
});

test("a slash that Escape closed stays closed when a peer writes before it, also with the caret elsewhere", async ({ browser }) => {
  const { page, id } = await open(browser, "First\n\nIntro");
  const text = textbox(page);
  await expect(text).toContainText("Intro");
  await text.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" /");
  const list = page.getByRole("listbox", { name: "Insert a block" });
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Home"); // the caret goes to another line
  const peer = await LiveDoc.join({ server: url(), id, token: BOB });
  await peer.edit((doc, author) => doc.replace({ text: "First" }, "A much longer first line", author));
  await peer.flush();
  await expect(text).toContainText("A much longer first line");
  await page.keyboard.press("Control+End"); // back after the closed slash
  await expect(list).toHaveCount(0);
  await page.keyboard.type("x"); // "x" finds Text, so a lost dismissal would open the menu
  await expect(list).toHaveCount(0);
  await peer.leave();
  await page.context().close();
});

test("the bubble menu stays in the window when the selection runs past it", async ({ browser }) => {
  const { page } = await open(browser, Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long text.`).join("\n\n"));
  await page.setViewportSize({ width: 900, height: 500 });
  await textbox(page).click();
  await page.keyboard.press("Control+a");
  const bubble = page.getByRole("toolbar", { name: "Selection" });
  await expect(bubble).toBeVisible();
  const box = (await page.locator(".agd-bubble").boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(500);
  // A selection scrolled fully out of view has no menu.
  await page.keyboard.press("Shift+ArrowLeft"); // a selection at the end only
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(bubble).toBeVisible();
  // With the focus in it, it stays, so the focus is not lost.
  await page.keyboard.press("Alt+F10");
  await expect(bubble.getByRole("button", { name: "Bold" })).toBeFocused();
  await page.mouse.wheel(0, -100000);
  await expect(bubble.getByRole("button", { name: "Bold" })).toBeFocused();
  await page.keyboard.press("Escape"); // back to the text
  await page.mouse.wheel(0, -100000);
  await expect(bubble).toHaveCount(0);

  // The slash menu hides too when its slash goes under the bar, still inside the window.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("End");
  await page.keyboard.type(" /");
  const list = page.getByRole("listbox", { name: "Insert a block" });
  await expect(list).toBeVisible();
  await page.evaluate(() => {
    const line = document.querySelector(".agd-prose p")!.getBoundingClientRect();
    const bar = document.querySelector(".agd-doc__bar")!.getBoundingClientRect();
    window.scrollBy(0, line.bottom - bar.height + 4); // the bar sticks at the top, and the line's bottom goes under it
  });
  await expect(list).toHaveCount(0);
  await page.context().close();
});

test("the slash menu opens the image dialog", async ({ browser }) => {
  const { page } = await open(browser, "Intro.");
  await textbox(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/ima");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Image" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(textbox(page)).not.toContainText("/ima");
  await page.context().close();
});

test("the bubble menu formats a selection, and Alt+F10 reaches it from the keyboard", async ({ browser }) => {
  const { page } = await open(browser, "Ship the editor on Friday");
  const text = textbox(page);
  await text.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Control+Shift+ArrowLeft");
  const bubble = page.getByRole("toolbar", { name: "Selection" });
  await expect(bubble).toBeVisible();
  await expectAccessible(page);
  await bubble.getByRole("button", { name: "Bold" }).click();
  await expect(text.locator("strong")).toHaveText("Friday");
  await expect(text).toBeFocused();
  await expect(bubble.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("Alt+F10");
  await expect(bubble.getByRole("button", { name: "Bold" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("button", { name: "Italic" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(text.locator("em")).toHaveText("Friday");
  await page.keyboard.press("Alt+F10");
  await page.keyboard.press("Escape");
  await expect(text).toBeFocused();
  await expect(bubble).toBeVisible(); // the selection is still there

  // A caret with no selection hides it.
  await page.keyboard.press("End");
  await expect(bubble).toHaveCount(0);
  await page.context().close();
});

test("a viewer gets no bubble menu and no slash menu", async ({ browser }) => {
  const { page } = await open(browser, "Read me only", VIC);
  const text = textbox(page);
  await expect(text).toContainText("Read me only");
  await text.dblclick();
  await expect(page.getByRole("toolbar", { name: "Selection" })).toHaveCount(0);
  await expect(text.locator("p[data-placeholder]")).toHaveCount(0);
  await page.context().close();
});

for (const theme of themes) {
  test(`the menus meet WCAG 2.2 AA in the ${theme} theme, and the screenshots`, async ({ browser }) => {
    const id = `menus-shot-${theme}-${Date.now().toString(36)}`;
    await createClient({ baseUrl: url(), token: ADA }).create({ id, markdown: "# Launch notes\n\nShip the editor on Friday, then write the release notes." });
    const page = await newPage(await browser.newContext({ colorScheme: theme, viewport: { width: 1100, height: 760 } }), ADA);
    await page.goto(`${url()}/#/d/${id}`);
    const text = textbox(page);
    await expect(text).toContainText("Ship the editor");
    await text.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(page.getByRole("listbox", { name: "Insert a block" })).toBeVisible();
    await expectAccessible(page);
    await shoot(page, "slash-menu", theme);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Home");
    await expect(page.getByRole("toolbar", { name: "Selection" })).toBeVisible();
    await expectAccessible(page);
    await shoot(page, "bubble-menu", theme);
    await page.context().close();
  });
}
