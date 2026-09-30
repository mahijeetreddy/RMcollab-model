import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

const COMPOSE = fileURLToPath(new URL("../infra/docker-compose.yml", import.meta.url));

/**
 * Clears one of the gateway's per-address limits ("code-miss", "demo"). Tests
 * all come from this machine's one address, so a limit a test uses up would
 * otherwise refuse every later test, and every run in the next hour.
 */
export function clearLimit(kind: string): void {
  execFileSync("docker", [
    "compose", "-f", COMPOSE, "exec", "-T", "redis", "sh", "-c",
    `redis-cli --scan --pattern "rmcollab:limit:${kind}:*" | xargs -r redis-cli DEL`,
  ], { stdio: "ignore" });
}

export interface ToAdd {
  /** A fixture path; or leave out and give `text`. */
  file?: string;
  text?: string;
  /**
   * A strategy name, chosen through the action button's "More options". Left out, the item goes
   * with whatever the room recommends - which for short text is a language
   * model, so tests that need an exact result name an offline strategy.
   */
  strategy?: string;
}

/**
 * Adds items through the room's "add media" panel the way a person does: drop
 * (set) the files or write the text, let each be identified and given its
 * proposal, optionally override it, then click once to add them all.
 */
export async function addToRoom(page: Page, items: ToAdd[]) {
  // In the feed the panel is behind a button once the feed has something in it.
  const closed = page.locator('.feed-add[aria-expanded="false"]');
  if (await closed.count()) await closed.click();
  const panel = page.locator(".add-media:visible").first();
  for (const item of items) {
    if (item.file) {
      await panel.locator('input[type="file"]').setInputFiles(item.file);
    } else {
      await panel.getByRole("button", { name: /write or paste text/i }).click();
      await panel.getByRole("textbox", { name: "Text" }).last().fill(item.text ?? "");
    }
  }
  const cards = panel.locator(".add-item");
  await expect(cards).toHaveCount(items.length);
  await expect(panel.getByText("Looking at your files")).toHaveCount(0, { timeout: 15_000 });

  for (let i = 0; i < items.length; i += 1) {
    const strategy = items[i]!.strategy;
    if (!strategy) continue;
    const card = cards.nth(i);
    await card.locator(".add-action").click();
    await card.locator(".add-more summary").click();
    await card.locator(".add-more select").selectOption(strategy);
  }

  await panel.getByRole("button", { name: /to the room$/i }).click();
  // Each item confirms and then leaves the queue once the room has it.
  await expect(cards).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Notes opens on the room's documents; this opens the room's own notes (where
 * uploads land) and waits until the editor has synced.
 */
export async function openRoomNotes(page: Page) {
  const home = page.locator(".docs-home");
  await expect(home.or(page.locator(".gdoc"))).toBeVisible();
  if (await home.isVisible()) await page.locator(".doc-card.is-main .doc-card-open").click();
  await expect(page.locator(".gdoc-save")).toContainText("Saved to the room");
}
