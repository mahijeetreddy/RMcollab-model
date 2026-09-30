import { expect, test, type Browser, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { addToRoom, clearLimit, openRoomNotes } from "../ui.js";

/**
 * Regenerates the README screenshots in docs/screenshots from a live stack:
 *
 *   npm run screenshots
 *
 * Built on the sample room ("Try a sample room"), whose material carries the
 * results this app really produced for it - so no image has to be read by the
 * vision model again, and a busy free tier cannot fail the run. The rewrite and
 * the answer in the Ask shot do call the text model (Groq).
 */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 (npm run screenshots) to regenerate the README images");
const OUT = fileURLToPath(new URL("../../docs/screenshots/", import.meta.url));
const LECTURE = fileURLToPath(new URL("../fixtures/lecture.mp3", import.meta.url));
const BOARD = fileURLToPath(new URL("../fixtures/whiteboard.jpg", import.meta.url));
const MESSY =
  "so basically teh meeting was about how we gonna scale the gateway, marcus said that redis streams is better then kafka for us cause nobody want to run zookeeper and priya will do the consumer groups part by friday.";

const VIEWPORT = { width: 1440, height: 900 };

async function open(browser: Browser, scheme: "light" | "dark"): Promise<Page> {
  const page = await (await browser.newContext({ colorScheme: scheme, viewport: VIEWPORT })).newPage();
  await page.goto("/");
  return page;
}

test("README screenshots", async ({ browser }) => {
  test.setTimeout(600_000);

  // Landing page, before anyone joins.
  const landing = await open(browser, "light");
  await expect(landing.getByRole("button", { name: "Try a sample room" })).toBeVisible();
  await landing.waitForTimeout(500);
  await landing.screenshot({ path: `${OUT}landing.png` });
  await landing.context().close();

  // Alice (light) opens a sample room; Bob (dark) joins it.
  const alice = await open(browser, "light");
  await alice.getByPlaceholder("Ada").fill("Alice");
  clearLimit("demo");
  await alice.getByRole("button", { name: "Try a sample room" }).click();
  await expect(alice.locator(".docs-home")).toBeVisible();
  const code = (await alice.locator(".code-chip").textContent())!.trim();

  // The room's documents: its notes, and one the group started.
  await alice.getByRole("button", { name: "New document" }).click();
  await expect(alice.locator("#notes-heading")).toHaveText("Untitled document");
  await alice.locator(".notes-prose").click();
  await alice.keyboard.type("# Exam plan");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("Midterm on the twelfth, open notes. Chapters 1 to 6, then two past papers each.");
  await alice.getByRole("button", { name: "All documents" }).click();
  await alice.getByRole("button", { name: "Actions for Untitled document" }).click();
  await alice.getByRole("menuitem", { name: "Rename" }).click();
  await alice.getByRole("textbox", { name: "Document name" }).fill("Exam plan");
  await alice.getByRole("textbox", { name: "Document name" }).press("Enter");
  await expect(alice.locator(".doc-card", { hasText: "Exam plan" })).toBeVisible();
  await alice.waitForTimeout(500);
  await alice.screenshot({ path: `${OUT}documents.png` });

  const bob = await open(browser, "dark");
  await bob.getByLabel("Session code").fill(code);
  await bob.getByPlaceholder("Ada").fill("Bob");
  await bob.getByRole("button", { name: /join session/i }).click();
  await openRoomNotes(bob);
  await openRoomNotes(alice);
  // Bob writes in the intro, so his cursor shows for Alice.
  await bob.locator(".notes-prose p").first().click();
  await bob.keyboard.press("End");
  await bob.keyboard.type(" Bob: I'll take the ordering question.");
  await expect(alice.locator(".collaboration-carets__label")).toHaveText("Bob");

  // Hero: Alice's notes, top of the document.
  await alice.evaluate(() => document.querySelector(".panel-body")?.scrollTo(0, 0));
  await alice.waitForTimeout(700);
  await alice.screenshot({ path: `${OUT}notes.png` });

  // Bob's dark view of the whiteboard read into notes.
  const board = bob.locator(".doc-section", { hasText: "whiteboard.jpg" });
  await board.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await bob.waitForTimeout(700);
  await bob.screenshot({ path: `${OUT}notes-dark-whiteboard.png` });

  // Ask the room: a cited answer, beside the notes.
  await alice.locator(".ask-toggle").click();
  const input = alice.getByRole("textbox", { name: "Ask the room" });
  await input.fill("Why did we pick Redis Streams over Kafka?");
  await input.press("Enter");
  await expect(alice.locator(".ask-turn").last()).toHaveAttribute("aria-busy", "false", { timeout: 90_000 });
  await alice.waitForTimeout(500);
  await alice.screenshot({ path: `${OUT}ask.png` });
  await alice.locator(".ask-close").click();

  // The lecture in the feed: transcript with timestamps tied to the player.
  await alice.getByRole("button", { name: "Feed", exact: true }).click();
  const lecture = alice.locator(".job-card", { hasText: "lecture.mp3" });
  await lecture.getByRole("tab", { name: "Transcript" }).click();
  const lines = lecture.getByRole("list", { name: "Transcript" }).getByRole("listitem");
  await lines.nth(1).getByRole("button", { name: /play from/i }).click();
  await lecture.locator(".doc-source audio").evaluate((el) => (el as HTMLAudioElement).pause());
  await lecture.scrollIntoViewIfNeeded();
  await alice.waitForTimeout(500);
  await lecture.screenshot({ path: `${OUT}transcript.png` });

  // Adding media: files recognised, each with the action that suits it.
  await alice.locator(".feed-add").click();
  const panel = alice.locator(".add-media:visible").first();
  await panel.locator('input[type="file"]').setInputFiles([LECTURE, BOARD]);
  await panel.getByRole("button", { name: /write or paste text/i }).click();
  await panel.getByRole("textbox", { name: "Text" }).fill(MESSY);
  await expect(panel.getByText("Looking at your files")).toHaveCount(0);
  await alice.evaluate(() => document.querySelector(".panel-body")?.scrollTo(0, 0));
  await alice.waitForTimeout(500);
  await panel.screenshot({ path: `${OUT}add-media.png` });
  await panel.getByRole("button", { name: "Clear" }).click();

  // A rewrite with its edits marked.
  await addToRoom(alice, [{ text: MESSY, strategy: "rewrite" }]);
  const rewrite = alice.locator(".job-card").first();
  await expect(rewrite.locator(".diff-summary")).toContainText(/edit/, { timeout: 60_000 });
  await rewrite.scrollIntoViewIfNeeded();
  await alice.waitForTimeout(500);
  await rewrite.screenshot({ path: `${OUT}rewrite-diff.png` });

  // Library search that finds a word spoken in the lecture.
  await alice.getByRole("button", { name: "Library", exact: true }).click();
  await alice.getByLabel(/search this room's documents/i).fill("gateway");
  await expect(alice.locator(".library-at").first()).toBeVisible({ timeout: 10_000 });
  await alice.waitForTimeout(600);
  await alice.screenshot({ path: `${OUT}library.png` });
});
