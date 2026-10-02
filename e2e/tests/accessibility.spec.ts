import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openRoomNotes } from "../ui.js";

/**
 * Automated accessibility checks (axe-core, WCAG 2.1 A and AA) on each main
 * screen, in light and dark. Automated rules catch perhaps a third of what
 * matters - missing names, contrast, roles in the wrong place - so this guards
 * against regressions; it does not replace trying the app with a keyboard and a
 * screen reader.
 */

async function violations(page: Page, what: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return result.violations.map(
    (v) => `${what}: ${v.id} (${v.impact}) ${v.help} - ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`,
  );
}

for (const theme of ["light", "dark"] as const) {
  test(`the main screens have no automatically detectable accessibility problems (${theme})`, async ({ page, browser }) => {
    test.setTimeout(150_000);
    await page.addInitScript((t) => window.localStorage.setItem("rmcollab.theme", t), theme);
    const found: string[] = [];

    await page.goto("/");
    await expect(page.getByRole("button", { name: /create session/i })).toBeVisible();
    found.push(...(await violations(page, "landing")));

    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "Privacy", level: 1 })).toBeVisible();
    found.push(...(await violations(page, "privacy")));

    await page.goto("/");
    await page.getByRole("button", { name: /create session/i }).click();
    await page.getByPlaceholder("Ada").fill("Alice");
    await page.getByRole("button", { name: /join session/i }).click();
    await openRoomNotes(page);
    found.push(...(await violations(page, "notes")));

    const code = (await page.locator(".code-chip").textContent())!.trim();
    await page.locator(".code-chip").click();
    await expect(page.getByRole("dialog", { name: "Invite people" })).toBeVisible();
    found.push(...(await violations(page, "invite menu")));
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Feed", exact: true }).click();
    found.push(...(await violations(page, "feed")));

    await page.locator(".chat-toggle").click();
    found.push(...(await violations(page, "chat")));
    await page.locator(".chat-close").click();

    // The waiting room, from both sides.
    await page.getByRole("switch", { name: /waiting room/i }).check();
    const guest = await (await browser.newContext()).newPage();
    await guest.addInitScript((t) => window.localStorage.setItem("rmcollab.theme", t), theme);
    await guest.goto(`/join/${code}`);
    await guest.getByPlaceholder("Ada").fill("Dan");
    await guest.getByRole("button", { name: /join session/i }).click();
    await expect(guest.getByRole("heading", { name: "Waiting to be let in" })).toBeVisible();
    found.push(...(await violations(guest, "waiting screen")));
    await expect(page.getByRole("group", { name: "Dan wants to join" })).toBeVisible();
    found.push(...(await violations(page, "join request")));

    expect(found, found.join("\n")).toEqual([]);
  });
}

test("destructive confirmations put the keyboard on Cancel, and Escape cancels", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create session/i }).click();
  await page.getByPlaceholder("Ada").fill("Alice");
  await page.getByRole("button", { name: /join session/i }).click();
  await openRoomNotes(page);
  await page.getByRole("button", { name: "End session…" }).click();
  const confirm = page.getByRole("alertdialog", { name: "End the session for everyone?" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  // Escape out of the invite menu returns to the code it opened from.
  await page.locator(".code-chip").click();
  await expect(page.getByRole("button", { name: "Copy invite link" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".code-chip")).toBeFocused();
});
