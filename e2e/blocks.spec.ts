import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "../src/client.js";
import { ADA, VIC } from "./tokens.js";
import { expectAccessible, newPage, shoot, themes, url } from "./helpers.js";

const textbox = (page: Page) => page.getByRole("textbox", { name: "Document text" });
const bar = (page: Page) => page.getByRole("toolbar", { name: "Formatting" });
const stored = async (id: string) => (await fetch(`${url()}/api/v1/docs/${id}/read`, { headers: { authorization: `Bearer ${ADA}` } })).text();

async function open(browser: Browser, markdown: string, token = ADA) {
  const id = `blocks-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await createClient({ baseUrl: url(), token: ADA }).create({ id, markdown });
  const page = await newPage(await browser.newContext(), token);
  await page.goto(`${url()}/#/d/${id}`);
  await expect(textbox(page)).toBeVisible();
  return { page, id };
}

test("in a table, the Table tool adds and removes rows and columns, and deletes the table", async ({ browser }) => {
  const { page, id } = await open(browser, "| Owner | Task |\n| - | - |\n| Ada | Plan |");
  const text = textbox(page);
  await text.getByText("Plan").click();
  const changes = bar(page).getByRole("button", { name: "Table changes" });
  const change = async (label: string) => (await changes.click(), await page.getByRole("menuitem", { name: label }).click());

  await change("Add row below");
  await expect(text.locator("tr")).toHaveCount(3);
  await change("Add column after");
  await expect(text.locator("tr").first().locator("th")).toHaveCount(3);
  await expect.poll(() => stored(id)).toMatch(/^\| Owner \| Task +\| +\|$/m);
  await change("Delete column");
  await expect(text.locator("tr").first().locator("th")).toHaveCount(2);
  await change("Delete row");
  await expect(text.locator("tr")).toHaveCount(2);
  await changes.click();
  await expectAccessible(page);
  await page.getByRole("menuitem", { name: "Delete table" }).click();
  await expect(text.locator("table")).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Table", exact: true })).toBeVisible(); // out of a table, it puts one in
  await page.context().close();
});

test("a code block takes a language, shows syntax colors, and keeps the language in Markdown", async ({ browser }) => {
  const { page, id } = await open(browser, "```\nconst answer = 42;\n```");
  const text = textbox(page);
  await text.locator("pre").click();
  const language = bar(page).getByRole("button", { name: "Code language: Plain text" });
  await language.click();
  await page.getByRole("menuitem", { name: "TypeScript" }).click();
  await expect(bar(page).getByRole("button", { name: "Code language: TypeScript" })).toBeVisible();
  await expect(text.locator("pre code")).toHaveClass(/language-typescript/);
  await expect(text.locator("pre .hljs-keyword").first()).toHaveText("const");
  await expect(text.locator("pre")).toHaveText("const answer = 42;"); // colors are decorations, not text
  await expect.poll(() => stored(id)).toContain("```typescript\nconst answer = 42;\n```");
  await expectAccessible(page);
  await page.context().close();
});

test("Download Markdown saves the text, and Import Markdown replaces it for everyone", async ({ browser }, info) => {
  const { page, id } = await open(browser, "# Notes\n\nFirst **draft**.\n\n- [x] done");
  await expect(textbox(page)).toContainText("First draft.");
  const more = page.getByRole("button", { name: "More actions" });

  await more.click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Download Markdown" }).click()]);
  expect(download.suggestedFilename()).toBe(`${id}.md`);
  expect(readFileSync((await download.path())!, "utf8")).toBe(await stored(id));

  const other = await newPage(await browser.newContext(), ADA);
  await other.goto(`${url()}/#/d/${id}`);
  await expect(textbox(other)).toContainText("First draft.");

  const write = (name: string, body: string) => (writeFileSync(info.outputPath(name), body), info.outputPath(name));
  await more.click();
  await page.getByRole("menuitem", { name: "Import Markdown" }).click();
  const dialog = page.getByRole("dialog", { name: "Import Markdown" });
  await dialog.getByLabel("Markdown file").setInputFiles(write("note.md", "Text with a note.[^1]\n\n[^1]: The note."));
  await dialog.getByRole("button", { name: "Replace the text" }).click();
  await expect(dialog.getByRole("alert")).toContainText("cannot be imported");
  await expect(page.locator(".agd-prose")).toContainText("First draft."); // a refused file changes nothing (the dialog hides the text from the accessibility tree)

  await dialog.getByLabel("Markdown file").setInputFiles(write("plan.md", "# Plan\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nlet x;\n```\n"));
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Replace the text" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(textbox(page).locator("h1")).toHaveText("Plan");
  await expect(textbox(page)).not.toContainText("First draft.");
  await expect(textbox(other).locator("table")).toBeVisible(); // the other tab gets it live
  await expect.poll(() => stored(id)).toBe("# Plan\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nlet x;\n```\n");

  // Undo takes the import back.
  await textbox(page).click();
  await bar(page).getByRole("button", { name: "Undo" }).click();
  await expect(textbox(page)).toContainText("First draft.");
  await other.context().close();
  await page.context().close();
});

test("a viewer can download but not import", async ({ browser }) => {
  const { page } = await open(browser, "Read me.", VIC);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Download Markdown" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Import Markdown" })).toHaveCount(0);
  await page.context().close();
});

for (const theme of themes) {
  test(`tables and code blocks meet WCAG 2.2 AA in the ${theme} theme, and the screenshots`, async ({ browser }) => {
    const id = `blocks-shot-${theme}-${Date.now().toString(36)}`;
    await createClient({ baseUrl: url(), token: ADA }).create({
      id,
      markdown: "# Release plan\n\n| Owner | Task | Due |\n| - | - | - |\n| Ada | Editor | Friday |\n| Bob | Notes | Monday |\n\n```typescript\n// Ship the editor\nconst due: string = \"Friday\";\nexport function ship(day = 5) {\n  return day > 4 ? due : null;\n}\n```\n\n- [x] Port the toolbar\n- [ ] Write the notes",
    });
    const page = await newPage(await browser.newContext({ colorScheme: theme, viewport: { width: 1100, height: 760 } }), ADA);
    await page.goto(`${url()}/#/d/${id}`);
    await textbox(page).getByText("Editor", { exact: true }).click();
    await expect(bar(page).getByRole("button", { name: "Table changes" })).toBeVisible();
    await expect(textbox(page).locator("pre .hljs-keyword").first()).toBeVisible();
    await expectAccessible(page);
    await shoot(page, "blocks", theme);
    await page.context().close();
  });
}
