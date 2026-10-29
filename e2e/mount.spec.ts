import { expect, test } from "@playwright/test";
import { createClient } from "../src/client.js";
import { AgenticDoc } from "../src/doc.js";
import { ADA, VIC } from "./tokens.js";
import { expectAccessible, url } from "./helpers.js";

// The page in e2e/embed/mount.html calls `mount` of `agentic-documents/ui` from the build, with a base URL and a token callback.
const sdk = (token: string) => createClient({ baseUrl: url(), token });
const open = (token: string, extra = "") => `${url()}/embed/mount.html#token=${encodeURIComponent(token)}${extra}`;

test("mount renders the document list, opens a document in the editor, and saves it on unmount", async ({ page }) => {
  const id = `mount-${Date.now()}`;
  await sdk(ADA).create({ id, markdown: "# Mounted\n\nStart." });
  await sdk(ADA).rename(id, { title: id });
  await page.goto(open(ADA));
  await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: id })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("link", { name: id }).click();
  const text = page.getByRole("textbox", { name: "Document text" });
  await expect(text).toContainText("Start.");
  // The app moves inside the host page. It does not change the host address.
  expect(new URL(page.url()).hash).toBe(`#token=${encodeURIComponent(ADA)}`);
  await expect(page.locator("#host-title")).toHaveText("Host app");

  await text.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Typed in the mounted app.");
  await page.evaluate(() => (window as unknown as { unmountApp: () => void }).unmountApp());
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect.poll(async () => AgenticDoc.fromUpdate(await sdk(ADA).state(id)).toMarkdown()).toContain("Typed in the mounted app.");
});

test("documentId opens that document first, and a viewer token reads it read only", async ({ page }) => {
  const id = `mount-view-${Date.now()}`;
  await sdk(ADA).create({ id, markdown: "Read me." });
  await page.goto(open(VIC, `&id=${id}`));
  const text = page.getByRole("textbox", { name: "Document text" });
  await expect(text).toContainText("Read me.");
  await expect(text).toHaveAttribute("contenteditable", "false");
});

test("a token the server refuses shows an alert in the host page", async ({ page }) => {
  await page.goto(open(`wrong-${"x".repeat(40)}`));
  await expect(page.getByRole("alert")).toContainText("The server did not accept this token.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});
