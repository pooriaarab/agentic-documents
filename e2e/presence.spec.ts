import { expect, test, type Page } from "@playwright/test";
import { createClient } from "../src/client.js";
import { ADA, BOB } from "./tokens.js";
import { expectAccessible, newPage, shoot, url } from "./helpers.js";

const textbox = (page: Page) => page.getByRole("textbox", { name: "Document text" });

test("two people see each other: the count, the caret with the name, the selection, and the leave", async ({ browser }) => {
  const id = `presence-${Date.now().toString(36)}`;
  await createClient({ baseUrl: url(), token: ADA }).create({ id, markdown: "# Plan\n\nShip the editor on Friday." });
  const ada = await newPage(await browser.newContext({ colorScheme: "light", viewport: { width: 1100, height: 600 } }), ADA);
  await ada.goto(`${url()}/#/d/${id}`);
  await expect(textbox(ada)).toContainText("Ship the editor");
  await expect(ada.getByText("1 person")).toBeVisible();

  const bob = await newPage(await browser.newContext(), BOB);
  await bob.goto(`${url()}/#/d/${id}`);
  await expect(textbox(bob)).toContainText("Ship the editor");
  await expect(ada.getByText("2 people")).toBeVisible();
  await expect(bob.getByText("2 people")).toBeVisible();

  // Bob selects a word. Ada sees his caret with his name, and his selection as a tint.
  await textbox(bob).getByText("Ship the editor on Friday.").click();
  await bob.keyboard.press("End");
  await bob.keyboard.press("Control+Shift+ArrowLeft");
  await expect(textbox(ada).locator(".agd-peer-selection")).toHaveText(".");
  await bob.keyboard.press("Control+Shift+ArrowLeft"); // the dot, then the word
  await expect(ada.locator(".agd-caret__tag")).toHaveText("Bob");
  await expect(textbox(ada).locator(".agd-peer-selection")).toHaveText("Friday.");
  await expectAccessible(ada);
  await shoot(ada, "presence", "light");

  // Bob types over his selection, and Ada sees it live.
  await bob.keyboard.type("Monday.");
  await expect(textbox(ada)).toContainText("Ship the editor on Monday.");
  await expect(textbox(ada).locator(".agd-peer-selection")).toHaveCount(0);

  // Ada's own caret is not drawn as a peer in her tab, and Bob sees hers.
  await textbox(ada).getByText("Plan").click();
  await expect(bob.locator(".agd-caret__tag")).toHaveText("Ada");
  await expect(ada.locator(".agd-caret__tag", { hasText: "Ada" })).toHaveCount(0);

  await bob.context().close();
  await expect(ada.getByText("1 person")).toBeVisible();
  await expect(ada.locator(".agd-caret")).toHaveCount(0);
  await ada.context().close();
});
