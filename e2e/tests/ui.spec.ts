import { expect, test, type Browser, type Page } from "@playwright/test";
import { addToRoom } from "../ui.js";
import { fileURLToPath } from "node:url";

import { waitForStrategy } from "../helpers.js";

const SMALL_PNG = fileURLToPath(new URL("../fixtures/small.png", import.meta.url));
const LECTURE = fileURLToPath(new URL("../fixtures/lecture.mp3", import.meta.url));
const LECTURE_VIDEO = fileURLToPath(new URL("../fixtures/lecture.mp4", import.meta.url));

/** Watches for uncaught errors; a crash on the join path once blanked the app. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

async function createAndJoin(page: Page, name: string): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: /create session/i }).click();
  // The code arrives from an async request; a retrying assertion waits for it
  // where a plain inputValue() would read the still-empty field.
  const codeField = page.getByLabel("Session code");
  await expect(codeField).toHaveValue(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  const code = await codeField.inputValue();
  await page.getByPlaceholder("Ada").fill(name);
  await page.getByRole("button", { name: /join session/i }).click();
  await expect(page.getByText("Main Room").first()).toBeVisible();
  // Rooms open on the notes; these tests work in the feed.
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  return code;
}

async function joinExisting(browser: Browser, code: string, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByLabel("Session code").fill(code);
  await page.getByPlaceholder("Ada").fill(name);
  await page.getByRole("button", { name: /join session/i }).click();
  await expect(page.getByText("Main Room").first()).toBeVisible();
  // Rooms open on the notes; these tests work in the feed.
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  return page;
}

test("creating and joining a session reaches the room without errors", async ({ page }) => {
  // Regression: the client once read the gateway's { session } envelope as a
  // bare Session, and the resulting undefined crashed the whole React tree.
  const errors = trackErrors(page);
  await createAndJoin(page, "Alice");
  await expect(page.getByRole("button", { name: /browse files/i })).toBeVisible();
  expect(errors).toEqual([]);
});

test("presence, chat, typing and unread work across two browsers", async ({ page, browser }) => {
  const code = await createAndJoin(page, "Alice");
  const bob = await joinExisting(browser, code, "Bob");

  await expect(page.getByText("Bob").first()).toBeVisible();

  // Chat is a dock, collapsed until opened.
  await expect(page.locator("#chat-popover")).toBeHidden();

  await page.locator(".chat-toggle").click();
  await bob.locator(".chat-toggle").click();
  await bob.getByLabel(/message the room/i).fill("are you there?");
  await expect(page.locator(".chat-typing")).toContainText("Bob is typing");

  await page.locator(".chat-close").click();
  await bob.getByLabel(/message the room/i).press("Enter");

  // A message arriving while the dock is closed raises the unread badge.
  await expect(page.locator(".chat-toggle.has-unread")).toBeVisible();
  await expect(page.locator(".chat-unread")).toContainText("1");

  await page.locator(".chat-toggle").click();
  await expect(page.getByText("are you there?", { exact: true })).toBeVisible();
  await expect(page.locator(".chat-unread")).toHaveCount(0);
  await expect(page.locator(".chat-typing")).toHaveText("");
});

test("a locked room shows its owner and asks others for the code", async ({ page, browser }) => {
  const code = await createAndJoin(page, "Alice");
  await page.getByLabel(/new breakout room name/i).fill("Group A");
  await page.getByLabel(/optional room code/i).fill("HUSH1");
  await page.getByRole("button", { name: /^add$/i }).click();

  // The creator is inside, marked as owner, and can reveal the code.
  await expect(page.locator(".owner-crown")).toBeVisible();
  await page.getByRole("button", { name: /show room code/i }).click();
  await expect(page.locator(".revealed-code")).toHaveText("HUSH1");

  const bob = await joinExisting(browser, code, "Bob");
  await bob.getByRole("button", { name: /Group A/i }).click();
  await expect(bob.getByLabel(/room code for/i)).toBeVisible();

  await bob.getByLabel(/room code for/i).fill("WRONG");
  await bob.getByRole("button", { name: /^enter$/i }).click();
  await expect(bob.getByText(/does not match/i).first()).toBeVisible();

  await bob.getByLabel(/room code for/i).fill("HUSH1");
  await bob.getByRole("button", { name: /^enter$/i }).click();
  // Entering clears the prompt rather than leaving it stranded.
  await expect(bob.getByLabel(/room code for/i)).toHaveCount(0);
  await expect(bob.locator(".owner-crown")).toBeVisible();
  await expect(bob.getByRole("button", { name: /show room code/i })).toHaveCount(0);
});

test("an image enhances on the GPU and shows before and after", async ({ page }) => {
  await createAndJoin(page, "Alice");
  await addToRoom(page, [{ file: SMALL_PNG, strategy: "realesrgan" }]);

  // The status badge's class, not the word "done": that word also appears in
  // hidden screen-reader text, which a text locator would latch onto first.
  await expect(page.locator(".badge-status-done")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByAltText(/original upload/i)).toBeVisible();
  await expect(page.getByAltText(/enhanced result/i)).toBeVisible();
});

test("a recording opens as a searchable transcript tied to the player", async ({ page }) => {
  await waitForStrategy("audio", "comprehend");
  const errors = trackErrors(page);
  await createAndJoin(page, "Alice");
  await addToRoom(page, [{ file: LECTURE }]);

  // A transcript is a document, not an "after" to compare against.
  const transcriptTab = page.getByRole("tab", { name: "Transcript" });
  await expect(transcriptTab).toBeVisible({ timeout: 150_000 });
  // With a language model configured a Summary tab exists and leads; without
  // one the transcript is the only document. Either way, it opens on click.
  const summaryTab = page.getByRole("tab", { name: "Summary" });
  if (await summaryTab.count()) {
    await expect(summaryTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".summary h4").first()).toBeVisible();
    await transcriptTab.click();
  }
  await expect(transcriptTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".compare")).toHaveCount(0);
  await expect(page.locator(".doc-facts")).toContainText(/Whisper/);

  const lines = page.getByRole("list", { name: "Transcript" }).getByRole("listitem");
  // The transcript text is fetched after the tab opens, and count() does not
  // wait: without this it read 0 whenever the fetch lost the race.
  await expect(lines.first()).toBeVisible();
  const total = await lines.count();
  expect(total).toBeGreaterThan(1);

  // Search narrows to matching lines and highlights the term.
  await page.getByPlaceholder("Search the transcript").fill("gateway");
  await expect(lines.first().locator("mark")).toHaveText(/gateway/i);
  expect(await lines.count()).toBeLessThan(total);
  await page.getByPlaceholder("Search the transcript").fill("zzzz-no-such-word");
  await expect(page.getByText(/nothing in the transcript matches/i)).toBeVisible();
  await page.getByPlaceholder("Search the transcript").fill("");
  await expect(lines).toHaveCount(total);

  // A timestamp seeks the original recording and marks that line as current.
  const last = lines.last();
  const stamp = (await last.locator(".transcript-stamp").textContent())!;
  const [h, m, s] = stamp.split(":").map(Number);
  await last.getByRole("button", { name: /play from/i }).click();
  await expect(last).toHaveAttribute("aria-current", "true");
  const position = await page
    .locator(".doc-source audio")
    .evaluate((el) => (el as HTMLAudioElement).currentTime);
  expect(position).toBeGreaterThanOrEqual(h! * 3600 + m! * 60 + s!);

  // From the library, a transcript hit opens at the line where it is spoken.
  await page.locator(".doc-source audio").evaluate((el) => (el as HTMLAudioElement).pause());
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByLabel(/search this room's documents/i).fill("action item");
  await expect(page.locator(".library-at")).toHaveText(/at 0:\d\d/);
  // The transcript's hit, the one with a time: the summary matches too (its
  // "Action items" heading), and which ranks first is a tie that varies. Clicking
  // "the first" sometimes opened the summary, with no line to find.
  await page.locator(".library-entry", { has: page.locator(".library-at") }).first().click();
  await expect(page.locator(".transcript-lines li.is-target")).toContainText(/action item/i);

  expect(errors).toEqual([]);
});

test("the library finds a document and opens it in the feed", async ({ page }) => {
  const errors = trackErrors(page);
  await createAndJoin(page, "Alice");
  await addToRoom(page, [{ text: "the albatross circled the harbour", strategy: "rulebased" }]);
  await expect(page.locator(".badge-status-done")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("button", { name: "Library", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByLabel(/search this room's documents/i).fill("albatrosses");
  const hit = page.locator(".library-entry");
  await expect(hit).toHaveCount(1);
  await expect(hit.locator("mark")).toHaveText(/albatross/i);

  await page.getByLabel(/search this room's documents/i).fill("penguin");
  await expect(page.getByText(/nothing in this room matches/i)).toBeVisible();
  await page.getByLabel(/search this room's documents/i).fill("albatross");

  await hit.click();
  // Back on the feed, with focus on the card the entry came from.
  await expect(page.getByRole("button", { name: "Feed", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".job-card").first()).toBeFocused();
  expect(errors).toEqual([]);
});

test("a text result marks what the enhancement changed", async ({ page }) => {
  // Side by side, a light edit reads as "nothing changed"; inline marks fix that.
  // The rule-based strategy is deterministic, so the edits are known exactly.
  const errors = trackErrors(page);
  await createAndJoin(page, "Alice");
  await addToRoom(page, [{ text: "teh cat sat on teh mat", strategy: "rulebased" }]);

  const card = page.locator(".job-card").first();
  await expect(card.locator(".diff-summary")).toContainText(/\d+ edits?/, { timeout: 60_000 });
  await expect(card.locator("del").first()).toHaveText("teh");
  await expect(card.locator("ins").first()).toHaveText("The");
  // The original pane stays clean; only the result is marked up.
  await expect(card.locator(".compare-pane").first().locator("ins, del")).toHaveCount(0);

  const toggle = card.getByRole("button", { name: "Show changes" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(card.locator("ins, del")).toHaveCount(0);
  await expect(card.locator(".compare-pane").nth(1).locator(".text-pane")).toHaveText("The cat sat on the mat.");
  expect(errors).toEqual([]);
});

test("a lecture video opens as a transcript whose timestamps seek the video", async ({ page }) => {
  await waitForStrategy("video", "comprehend");
  const errors = trackErrors(page);
  await createAndJoin(page, "Alice");
  await addToRoom(page, [{ file: LECTURE_VIDEO }]);

  const transcriptTab = page.getByRole("tab", { name: "Transcript" });
  await expect(transcriptTab).toBeVisible({ timeout: 150_000 });
  await transcriptTab.click();
  // The player above the documents is the video itself, not an audio element.
  const player = page.locator(".doc-source video");
  await expect(player).toBeVisible();

  const last = page.getByRole("list", { name: "Transcript" }).getByRole("listitem").last();
  await last.getByRole("button", { name: /play from/i }).click();
  await expect(last).toHaveAttribute("aria-current", "true");
  const position = await player.evaluate((el) => (el as HTMLVideoElement).currentTime);
  expect(position).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("several files at once are each identified and given a proposal, sent only on click", async ({ page }) => {
  const errors = trackErrors(page);
  await createAndJoin(page, "Alice");
  const panel = page.locator(".add-media").first();
  await panel.locator('input[type="file"]').setInputFiles([LECTURE, SMALL_PNG]);
  await panel.getByRole("button", { name: /write or paste text/i }).click();
  await panel.getByRole("textbox", { name: "Text" }).fill("teh group met on thursday");

  const cards = panel.locator(".add-item");
  await expect(cards).toHaveCount(3);
  await expect(panel.getByText("Looking at your files")).toHaveCount(0, { timeout: 15_000 });
  // Each kind gets the action that suits it, already chosen.
  const action = (i: number) => cards.nth(i).locator(".add-action-title");
  await expect(action(0)).toHaveText("Transcribe & summarise");
  await expect(action(1)).toHaveText(/Read into notes|Sharpen & upscale/);
  await expect(action(2)).toHaveText(/Polish the writing|Fix typos only/);

  // The alternatives open on demand, and picking one closes them again.
  await cards.nth(1).locator(".add-action").click();
  await cards.nth(1).getByText("Quick brightness fix").click();
  await expect(action(1)).toHaveText("Quick brightness fix");
  await expect(cards.nth(1).locator(".add-choices")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Add 3 items to the room" })).toBeEnabled();

  // Detection alone sends nothing.
  await page.waitForTimeout(1_000);
  await expect(page.locator(".job-card")).toHaveCount(0);
  expect(errors).toEqual([]);
});
