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

  // In the header row, no row goes above it and it is not deleted, since Markdown makes the first row the header.
  await text.getByText("Owner").click();
  await changes.click();
  await expect(page.getByRole("menuitem", { name: "Add row below" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Add row above" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete row" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // A cell selection from the header row down counts as the header row too. This one covers every column as well.
  await text.getByText("Owner").click();
  await text.locator("tr").nth(1).locator("td").last().click({ modifiers: ["Shift"] });
  await changes.click();
  await expect(page.getByRole("menuitem", { name: "Delete row" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Add row above" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete column" })).toHaveCount(0); // it covers every column
  await page.keyboard.press("Escape");
  // With one column left, Delete column is gone: Delete table removes the table.
  await text.locator("tr").nth(1).locator("td").last().click();
  await change("Delete column");
  await expect(text.locator("tr").first().locator("th")).toHaveCount(1);
  await changes.click();
  await expect(page.getByRole("menuitem", { name: "Delete column" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await changes.click();
  await expectAccessible(page);
  await page.getByRole("menuitem", { name: "Delete table" }).click();
  await expect(text.locator("table")).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Table", exact: true })).toBeVisible(); // out of a table, it puts one in
  await page.context().close();
});

test("a code block takes a language, shows syntax colors, and keeps the language in Markdown", async ({ browser }) => {
  const { page, id } = await open(browser, "```\nconst answer = 42;\n```\n\n```ts\nlet a = 1;\n```\n\n```mermaid\ngraph TD; const --> x\n```");
  const text = textbox(page);
  await text.locator("pre").first().click();
  const language = bar(page).getByRole("button", { name: "Code language: Plain text" });
  await language.click();
  await page.getByRole("menuitem", { name: "TypeScript" }).click();
  await expect(bar(page).getByRole("button", { name: "Code language: TypeScript" })).toBeVisible();
  await expect(text.locator("pre code").first()).toHaveClass(/language-typescript/);
  await expect(text.locator("pre").first().locator(".hljs-keyword").first()).toHaveText("const");
  await expect(text.locator("pre").first()).toHaveText("const answer = 42;"); // colors are decorations, not text
  await expect.poll(() => stored(id)).toContain("```typescript\nconst answer = 42;\n```");

  // A fence alias names its language, and the menu marks it in use.
  await text.locator("pre").nth(1).click();
  await bar(page).getByRole("button", { name: "Code language: TypeScript" }).click();
  await expect(page.getByRole("menuitem", { name: "TypeScript (in use)" })).toBeVisible();
  await page.keyboard.press("Escape");
  // A language with no bundled grammar is plain text: nothing is guessed.
  await expect(text.locator("pre").nth(2).locator("[class^='hljs-']")).toHaveCount(0);
  await expectAccessible(page);
  await page.context().close();
});

test("Download Markdown saves the text, and Import Markdown replaces it for everyone", async ({ browser }, info) => {
  const { page, id } = await open(browser, "# Notes\n\nFirst **draft**.\n\n- [x] done");
  await expect(textbox(page)).toContainText("First draft.");
  const more = page.getByRole("button", { name: "More actions" });

  // The file is named after the title, read when the download starts, with the characters a file name cannot hold
  // made spaces. Someone else renames the document while the page is open.
  await createClient({ baseUrl: url(), token: ADA }).rename(id, { title: "Q3/plan: notes" });
  await more.click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Download Markdown" }).click()]);
  expect(download.suggestedFilename()).toBe("Q3 plan notes.md");
  expect(readFileSync((await download.path())!, "utf8")).toBe(await stored(id));

  const other = await newPage(await browser.newContext(), ADA);
  await other.goto(`${url()}/#/d/${id}`);
  await expect(textbox(other)).toContainText("First draft.");

  const write = (name: string, body: string) => (writeFileSync(info.outputPath(name), body), info.outputPath(name));
  await more.click();
  await page.getByRole("menuitem", { name: "Import Markdown" }).click();
  const dialog = page.getByRole("dialog", { name: "Import Markdown" });
  await dialog.getByLabel("Markdown file").setInputFiles(write("big.md", "word ".repeat(120 * 1024)));
  await dialog.getByRole("button", { name: "Replace the text" }).click();
  await expect(dialog.getByRole("alert")).toContainText("512 KB or less"); // an import stays under the room limit
  // Many small blocks make a document far larger than its Markdown: the size of the document is what counts.
  await dialog.getByLabel("Markdown file").setInputFiles(write("tasks.md", "- [ ] x\n".repeat(30000)));
  await dialog.getByRole("button", { name: "Replace the text" }).click();
  await expect(dialog.getByRole("alert")).toContainText("a live room keeps");
  await dialog.getByLabel("Markdown file").setInputFiles(write("note.md", "Text with a note.[^1]\n\n[^1]: The note."));
  await dialog.getByRole("button", { name: "Replace the text" }).click();
  await expect(dialog.getByRole("alert")).toContainText("cannot be imported");
  await expect(page.locator(".agd-prose")).toContainText("First draft."); // a refused file changes nothing (the dialog hides the text from the accessibility tree)

  await dialog.getByLabel("Markdown file").setInputFiles(write("plan.md", "# Plan\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nlet x;\n```\n\n![bad](javascript:alert)\n"));
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Replace the text" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(textbox(page).locator("h1")).toHaveText("Plan");
  await expect(textbox(page)).not.toContainText("First draft.");
  await expect(textbox(other).locator("table")).toBeVisible(); // the other tab gets it live
  await expect.poll(() => stored(id)).toContain("# Plan\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nlet x;\n```\n");
  expect(await stored(id)).not.toContain("javascript"); // an image a paste would not keep is dropped from an import too

  // Undo takes the import back.
  await textbox(page).click();
  await bar(page).getByRole("button", { name: "Undo" }).click();
  await expect(textbox(page)).toContainText("First draft.");
  await other.context().close();
  await page.context().close();
});

test("once the document is removed and the editor is read only, Import Markdown is gone", async ({ browser }) => {
  const { page, id } = await open(browser, "Soon gone.");
  await textbox(page).click();
  await page.keyboard.type(" More.");
  await createClient({ baseUrl: url(), token: ADA }).remove(id);
  await page.keyboard.type(" Again.");
  await expect(page.getByRole("status").filter({ hasText: "was removed" })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Download Markdown" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Import Markdown" })).toHaveCount(0);
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
