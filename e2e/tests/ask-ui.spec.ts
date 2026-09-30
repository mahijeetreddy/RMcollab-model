import { expect, test, type Page } from "@playwright/test";
import { addToRoom, openRoomNotes } from "../ui.js";

// AUDIT_OUT=<dir> keeps screenshots of each state, for reviewing the design.
const OUT = process.env.AUDIT_OUT;
const shot = async (page: Page, name: string) => {
  if (OUT) await page.screenshot({ path: `${OUT}/${name}.png` });
};

async function roomWithMaterial(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /create session/i }).click();
  await expect(page.getByLabel("Session code")).toHaveValue(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  await page.getByPlaceholder("Ada").fill("Alice");
  await page.getByRole("button", { name: /join session/i }).click();
  await openRoomNotes(page);

  // The room's own notes, typed as a person would.
  await page.locator(".notes-prose").click();
  await page.keyboard.type("# Open questions");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Does the load balancer need sticky sessions for websockets? No: the upgrade pins the connection.");

  await page.getByRole("button", { name: "Add media" }).click();
  await addToRoom(page, [
    {
      text: "We compared Kafka and Redis Streams. We decided on Redis Streams, because nobody wants to run ZooKeeper for a class project. Priya writes the consumer groups section by Friday.",
      strategy: "rulebased",
    },
  ]);
  await expect(page.locator(".doc-section-status")).toHaveText("Added to notes", { timeout: 60_000 });
  await page.getByRole("button", { name: "Add media" }).click();
}

test("ask the room: a streamed, cited answer that opens its sources and can join the notes", async ({ page }) => {
  test.setTimeout(240_000);
  await roomWithMaterial(page);

  // A dock beside the chat, openable from any view; one dock at a time.
  await page.locator(".chat-toggle").click();
  await expect(page.locator("#chat-popover")).toBeVisible();
  await page.getByRole("button", { name: "Ask the room", exact: true }).click();
  await expect(page.locator("#chat-popover")).toBeHidden();
  await expect(page.getByText("Answers come only from what this room holds")).toBeVisible();
  await shot(page, "ask-empty");

  // Escape closes it; Ctrl/Cmd+K brings it back from anywhere.
  await page.keyboard.press("Escape");
  await expect(page.locator("#ask-popover")).toBeHidden();
  await page.keyboard.press("Control+k");
  await expect(page.locator("#ask-popover")).toBeVisible();

  // Embeddings land a moment after a job finishes; until then retrieval leans
  // on keywords, which this question also has.
  const input = page.getByRole("textbox", { name: "Ask the room" });
  await input.fill("Which message broker did we choose, and why?");
  await input.press("Enter");
  const turn = page.locator(".ask-turn").first();
  await expect(turn.locator(".ask-question")).toHaveText("Which message broker did we choose, and why?");
  await expect(turn).toHaveAttribute("aria-busy", "false", { timeout: 90_000 });
  await shot(page, "ask-answer");

  const fallback = await turn.locator(".ask-note.is-warn").count();
  test.skip(fallback > 0, "no answer model available: sources-only path");
  await expect(turn.locator(".ask-answer")).toContainText(/Redis\s+Streams/i);
  const cites = turn.locator(".ask-answer .ask-cite");
  expect(await cites.count()).toBeGreaterThan(0);
  await expect(turn.locator(".ask-sources").first().locator(".ask-source")).not.toHaveCount(0);

  // Add to notes: the question and the answer land at the end of the shared notes.
  await turn.getByRole("button", { name: "Add to notes" }).click();
  await expect(page.getByRole("button", { name: "Notes", exact: true })).toHaveAttribute("aria-pressed", "true");
  const added = page.locator(".notes-prose > h3").filter({ hasText: "Which message broker did we choose, and why?" });
  await expect(added).toBeVisible();
  await expect(page.locator(".notes-prose")).toContainText(/Sources: \[\d\]/);
  await shot(page, "ask-added-to-notes");

  // Every citation in the notes is a link back to its source - the [n] in the
  // text and each entry in the sources line - and it works for anyone in the room.
  const links = page.locator('.notes-prose a[href^="#rmc-source"]');
  expect(await links.count()).toBeGreaterThanOrEqual(2);
  // Adding closed the dock, so the new section is in view.
  await expect(page.locator("#ask-popover")).toBeHidden();
  await links.first().click();
  // The cited document is an upload: it opens as its card in the feed.
  await expect(page.getByRole("button", { name: "Feed", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".job-card").first()).toBeFocused();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  // Opening the dock again for the next check.
  await page.keyboard.press("Control+k");

  // A citation opens where it came from, with the answer still beside it.
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await page.locator(".ask-turn").first().locator(".ask-answer .ask-cite").first().click();
  await expect(page.locator("#ask-popover")).toBeVisible();
  const view = page.getByRole("button", { name: /^(Feed|Notes)$/, pressed: true });
  await expect(view).toBeVisible();
});

test("ask the room says when there is nothing to answer from", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /create session/i }).click();
  await expect(page.getByLabel("Session code")).toHaveValue(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  await page.getByPlaceholder("Ada").fill("Alice");
  await page.getByRole("button", { name: /join session/i }).click();
  await page.getByRole("button", { name: "Ask the room", exact: true }).click();
  await page.getByRole("button", { name: "What did we decide?" }).click();
  await expect(page.locator(".ask-turn").first()).toContainText("Nothing has been added to this room yet");
  await shot(page, "ask-nothing");
});

test("the dock in dark mode and on a phone", async ({ browser }) => {
  test.skip(!OUT, "screenshots only");
  for (const [name, options] of [
    ["dark", { colorScheme: "dark" as const, viewport: { width: 1440, height: 900 } }],
    ["phone", { viewport: { width: 390, height: 844 } }],
  ] as const) {
    const page = await (await browser.newContext(options)).newPage();
    await page.goto("/");
    await page.getByRole("button", { name: /create session/i }).click();
    await expect(page.getByLabel("Session code")).toHaveValue(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    await page.getByPlaceholder("Ada").fill("Alice");
    await page.getByRole("button", { name: /join session/i }).click();
    await openRoomNotes(page);
    await shot(page, `ask-${name}-closed`);
    await page.locator(".ask-toggle").click();
    await page.getByRole("button", { name: "What did we decide?" }).click();
    await expect(page.locator(".ask-turn").first()).toContainText("Nothing has been added");
    await shot(page, `ask-${name}-open`);
    await page.context().close();
  }
});
