import { expect, test } from "@playwright/test";
import { expectAccessible, url } from "./helpers.js";

test("public review UI supports keyboard proposals, decisions and comment anchors", async ({ page }) => {
  await page.goto(`${url()}/embed/review.html`);
  await expect(page.getByText("Machine-made: Scribe (agent)")).toBeVisible();
  await page.getByRole("button", { name: "Accept", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("accepted", { exact: true })).toBeVisible();
  await page.getByLabel("Review mode").selectOption("suggest");
  await page.getByLabel("Exact text", { exact: true }).fill("earth");
  await page.getByLabel("Proposed Markdown").fill("planet");
  await page.getByRole("button", { name: "Propose suggestion" }).click();
  const own = page.getByRole("article", { name: "Suggestion by Ada" });
  await expect(own.getByRole("button", { name: "Accept", exact: true })).toBeDisabled();
  await expect(own.getByRole("button", { name: "Reject", exact: true })).toBeDisabled();
  await page.getByLabel("Comment", { exact: true }).fill("Check this word");
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await page.getByRole("button", { name: "Show text: earth" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("earth");
  await expectAccessible(page);
});

test("an agent cannot accept or reject its proposal even with decision scope", async ({ page }) => {
  await page.goto(`${url()}/embed/review.html#self`);
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reject", exact: true })).toBeDisabled();
});
