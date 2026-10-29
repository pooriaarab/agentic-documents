import AxeBuilder from "@axe-core/playwright";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

export const url = () => process.env.E2E_URL!;

export async function signIn(page: Page, token: string) {
  await page.goto(url());
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeVisible();
}

export async function newPage(context: BrowserContext, token: string): Promise<Page> {
  const page = await context.newPage();
  await signIn(page, token);
  return page;
}

/** WCAG 2.2 AA, with every rule tagged at that level or below. */
export async function expectAccessible(page: Page) {
  // A dialog fades in. Axe blends its colors with the page while it fades, and reports a contrast it will not have.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

/** The review set of screenshots. It is written only when UPDATE_SCREENSHOTS=1, so a normal run leaves the files alone. */
export async function shoot(page: Page, name: string, theme: "light" | "dark") {
  if (process.env.UPDATE_SCREENSHOTS !== "1") return;
  mkdirSync("docs/screenshots", { recursive: true });
  await page.screenshot({ path: `docs/screenshots/${name}-${theme}.png`, animations: "disabled" });
}

export const themes = ["light", "dark"] as const;
