import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { addToRoom, openRoomNotes } from "../ui.js";

// AUDIT_OUT=<dir> keeps the rendered PDF, for looking at the print layout.
const OUT = process.env.AUDIT_OUT;

async function notesWithContent(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /create session/i }).click();
  await expect(page.getByLabel("Session code")).toHaveValue(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  await page.getByPlaceholder("Ada").fill("Alice");
  await page.getByRole("button", { name: /join session/i }).click();
  await openRoomNotes(page);

  // Typed the way a person does, through the editor's own shortcuts.
  await page.locator(".notes-prose").click();
  await page.keyboard.type("# Week 6");
  await page.keyboard.press("Enter");
  await page.keyboard.type("We chose **Redis Streams** over Kafka.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[ ] Priya drafts the report");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: "Add media" }).click();
  await addToRoom(page, [{ text: "teh group met on thursday", strategy: "rulebased" }]);
  await expect(page.locator(".doc-section-status")).toHaveText("Added to notes", { timeout: 60_000 });
  await page.getByRole("button", { name: "Add media" }).click();
}

test.describe("exporting the notes", () => {
  test("Markdown download holds the notes, the checklist and each upload's section", async ({ page }) => {
    await notesWithContent(page);
    await page.getByRole("button", { name: "Export" }).click();
    const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /download markdown/i }).click()]);

    expect(file.suggestedFilename()).toMatch(/^main-room-notes-\d{4}-\d{2}-\d{2}\.md$/);
    const md = await readFile((await file.path())!, "utf8");
    expect(md).toMatch(/^# Main Room notes\n\n_Exported from RMcollab on .+_\n\n# Week 6\n\nWe chose \*\*Redis Streams\*\* over Kafka\.\n\n- \[ \] Priya drafts the report\n/);
    // The upload's section: its title, who added it, and the enhanced text.
    // Pasted text is titled by its first words.
    expect(md).toMatch(/## teh group met on thursday\n\n_Text · Alice · .+_\n\nThe group met on thursday\./);
    // The menu closes once the file is made.
    await expect(page.locator(".gdoc-export-menu")).toHaveCount(0);
  });

  test("printing lays out only the notes, with section titles, as a real PDF", async ({ page }) => {
    await notesWithContent(page);
    // The print dialog cannot be driven headless; record the call instead, and
    // render the print layout the browser would send to it.
    await page.evaluate(() => {
      (window as unknown as { printed: number }).printed = 0;
      window.print = () => {
        (window as unknown as { printed: number }).printed += 1;
      };
    });
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("button", { name: /print or save as pdf/i }).click();
    expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);

    await page.emulateMedia({ media: "print" });
    await expect(page.locator("#root")).toBeHidden();
    const printed = page.locator(".print-root");
    await expect(printed).toBeVisible();
    await expect(printed.locator(".print-head h1")).toHaveText("Main Room notes");
    await expect(printed.locator("section h2")).toHaveText("teh group met on thursday");
    await expect(printed.locator(".print-meta")).toHaveText("Text · Alice");
    await expect(printed).toContainText("The group met on thursday.");
    // No editor chrome in the copy: no buttons, no editable surface.
    await expect(printed.locator("button, [contenteditable]")).toHaveCount(0);

    const pdf = await page.pdf({ format: "A4", path: OUT ? `${OUT}/notes.pdf` : undefined });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

    // Back on screen the copy is gone once printing ends.
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await expect(page.locator(".print-root")).toHaveCount(0);
  });
});
