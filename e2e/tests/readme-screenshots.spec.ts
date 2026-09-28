import { expect, test, type Browser, type Page } from "@playwright/test";
import { addToRoom } from "../ui.js";
import { fileURLToPath } from "node:url";

/**
 * Regenerates the README screenshots in docs/screenshots from a live stack:
 *
 *   npm run screenshots
 *
 * Opt-in because it is not a test of anything, and it reads a whiteboard photo
 * with the configured vision model, which spends a vision API call.
 */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 (npm run screenshots) to regenerate the README images");
const OUT = fileURLToPath(new URL("../../docs/screenshots/", import.meta.url));
const LECTURE = fileURLToPath(new URL("../fixtures/lecture.mp3", import.meta.url));
const BOARD = fileURLToPath(new URL("../fixtures/whiteboard.jpg", import.meta.url));
const MEETING =
  "Study group, week 6. We went through message queues and consumer groups. We decided to use Redis Streams rather than Kafka because nobody wants to run ZooKeeper. Priya will write the consumer groups section of the report by Friday. Marcus will rerun the benchmark with three workers. Nobody could say whether exactly-once delivery is achievable.";
const MESSY =
  "so basically teh meeting was about how we gonna scale the gateway, marcus said that redis streams is better then kafka for us cause nobody want to run zookeeper and priya will do the consumer groups part by friday.";

const VIEWPORT = { width: 1440, height: 900 };

async function open(browser: Browser, scheme: "light" | "dark"): Promise<Page> {
  const page = await (await browser.newContext({ colorScheme: scheme, viewport: VIEWPORT })).newPage();
  await page.goto("/");
  return page;
}

async function join(page: Page, name: string, code?: string): Promise<string> {
  if (code) await page.getByPlaceholder("ABC123").fill(code);
  else {
    await page.getByRole("button", { name: /create session/i }).click();
    await expect(page.getByPlaceholder("ABC123")).toHaveValue(/^[A-Z0-9]{6}$/);
  }
  const joined = await page.getByPlaceholder("ABC123").inputValue();
  await page.getByPlaceholder("Ada").fill(name);
  await page.getByRole("button", { name: /join session/i }).click();
  await expect(page.locator(".gdoc-save")).toContainText("Saved to the room");
  return joined;
}


test("README screenshots", async ({ browser }) => {
  test.setTimeout(600_000);

  // 6. Landing page, before anyone joins.
  const landing = await open(browser, "light");
  await expect(landing.getByRole("button", { name: /create session/i })).toBeVisible();
  await landing.waitForTimeout(500);
  await landing.screenshot({ path: `${OUT}landing.png` });
  await landing.context().close();

  // Alice (light) starts the room's notes and adds three uploads.
  const alice = await open(browser, "light");
  const code = await join(alice, "Alice");
  await alice.locator(".notes-prose").click();
  await alice.keyboard.type("Distributed systems study group");
  await alice.getByLabel("Paragraph style").selectOption("h1");
  await alice.keyboard.press("End");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("Week 6 notes. Uploads below add their summaries automatically as they finish.");

  // All three at once, the way the new panel is meant to be used.
  await alice.getByRole("button", { name: "Add media" }).click();
  await addToRoom(alice, [{ text: MEETING, strategy: "summarise" }, { file: LECTURE }, { file: BOARD }]);
  await alice.getByRole("button", { name: "Add media" }).click();
  const sections = alice.locator(".doc-section");
  await expect(sections).toHaveCount(3, { timeout: 30_000 });
  for (let i = 0; i < 3; i += 1) {
    await expect(sections.nth(i).locator(".doc-section-status")).toHaveText("Added to notes", { timeout: 180_000 });
  }

  // Bob (dark) joins and writes in the intro, so his cursor shows for Alice.
  const bob = await open(browser, "dark");
  await join(bob, "Bob", code);
  await bob.locator(".notes-prose p").first().click();
  await bob.keyboard.press("End");
  await bob.keyboard.type(" Bob: I'll look into the ordering question.");
  await expect(alice.locator(".collaboration-carets__label")).toHaveText("Bob");

  // 1. Hero: Alice's notes, top of the document.
  await alice.locator(".gdoc-canvas").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await alice.evaluate(() => document.querySelector(".panel-body")?.scrollTo(0, 0));
  await alice.waitForTimeout(700);
  await alice.screenshot({ path: `${OUT}notes.png` });

  // 2. Bob's dark view of the whiteboard read into notes.
  await bob.locator(".doc-section").nth(2).scrollIntoViewIfNeeded();
  await bob.locator(".doc-section").nth(2).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await bob.waitForTimeout(700);
  await bob.screenshot({ path: `${OUT}notes-dark-whiteboard.png` });

  // 3. The lecture in the feed: transcript with timestamps tied to the player.
  await alice.getByRole("button", { name: "Feed", exact: true }).click();
  const lecture = alice.locator(".job-card", { hasText: "lecture.mp3" });
  await lecture.getByRole("tab", { name: "Transcript" }).click();
  const lines = lecture.getByRole("list", { name: "Transcript" }).getByRole("listitem");
  await lines.nth(1).getByRole("button", { name: /play from/i }).click();
  await lecture.locator(".doc-source audio").evaluate((el) => (el as HTMLAudioElement).pause());
  await lecture.scrollIntoViewIfNeeded();
  await alice.waitForTimeout(500);
  await lecture.screenshot({ path: `${OUT}transcript.png` });

  // 4. A rewrite with its edits marked.
  await addToRoom(alice, [{ text: MESSY, strategy: "rewrite" }]);
  const rewrite = alice.locator(".job-card").first();
  await expect(rewrite.locator(".diff-summary")).toContainText(/edit/, { timeout: 60_000 });
  await rewrite.scrollIntoViewIfNeeded();
  await alice.waitForTimeout(500);
  await rewrite.screenshot({ path: `${OUT}rewrite-diff.png` });

  // 5. Library search that finds a word spoken in the lecture.
  await alice.getByRole("button", { name: "Library", exact: true }).click();
  await alice.getByLabel(/search this room's documents/i).fill("gateway");
  await expect(alice.locator(".library-at").first()).toBeVisible({ timeout: 10_000 });
  await alice.waitForTimeout(600);
  await alice.screenshot({ path: `${OUT}library.png` });
});
