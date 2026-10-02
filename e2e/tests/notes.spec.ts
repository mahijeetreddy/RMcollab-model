import { expect, test, type Browser, type Page } from "@playwright/test";
import { addToRoom, openRoomNotes } from "../ui.js";

/** Joins (or creates) a session in a fresh browser and opens the room notes. */
async function openNotes(browser: Browser, name: string, code?: string): Promise<{ page: Page; code: string }> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  if (code) {
    await page.getByLabel("Session code").fill(code);
  } else {
    await page.getByRole("button", { name: /create session/i }).click();
    await expect(page.getByLabel("Session code")).toHaveValue(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  }
  const joined = await page.getByLabel("Session code").inputValue();
  await page.getByPlaceholder("Ada").fill(name);
  await page.getByRole("button", { name: /join session/i }).click();
  await expect(page.getByText("Main Room").first()).toBeVisible();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await openRoomNotes(page);
  return { page, code: joined };
}

test.describe("room notes", () => {
  test("two people edit the same notes live, with each other's cursors", async ({ browser }) => {
    const { page: alice, code } = await openNotes(browser, "Alice");
    const { page: bob } = await openNotes(browser, "Bob", code);

    await alice.locator(".notes-prose").click();
    await alice.keyboard.type("# Study notes");
    await alice.keyboard.press("Enter");
    await alice.keyboard.type("Streams over Kafka.");
    await expect(bob.locator(".notes-prose h1")).toHaveText("Study notes");
    await expect(bob.locator(".notes-prose")).toContainText("Streams over Kafka.");

    await bob.locator(".notes-prose p").first().click();
    await bob.keyboard.press("End");
    await bob.keyboard.type(" No ZooKeeper.");
    await expect(alice.locator(".notes-prose")).toContainText("Streams over Kafka. No ZooKeeper.");

    // Presence: a named cursor and an avatar per person.
    await expect(alice.locator(".collaboration-carets__label")).toHaveText("Bob");
    await expect(alice.locator(".gdoc-avatar")).toHaveCount(2);
  });

  test("a checklist ticked by one person is ticked for everyone", async ({ browser }) => {
    const { page: alice, code } = await openNotes(browser, "Alice");
    const { page: bob } = await openNotes(browser, "Bob", code);
    await alice.locator(".notes-prose").click();
    await alice.getByRole("button", { name: "Checklist" }).click();
    await alice.keyboard.type("Priya writes the report");
    const bobBox = bob.locator('.notes-prose input[type="checkbox"]').first();
    await expect(bobBox).not.toBeChecked();
    await alice.locator('.notes-prose input[type="checkbox"]').first().check();
    await expect(bobBox).toBeChecked();
  });

  test("the notes are saved: a fresh page load gets them back", async ({ browser }) => {
    const { page: alice, code } = await openNotes(browser, "Alice");
    await alice.locator(".notes-prose").click();
    await alice.keyboard.type("Kept after everyone leaves");
    // Past the gateway's batch window, then everyone goes away.
    await alice.waitForTimeout(800);
    await alice.context().close();

    const { page: later } = await openNotes(browser, "Later", code);
    await expect(later.locator(".notes-prose")).toContainText("Kept after everyone leaves");
  });

  test("undo takes back only your own typing, never a collaborator's", async ({ browser }) => {
    const { page: alice, code } = await openNotes(browser, "Alice");
    const { page: bob } = await openNotes(browser, "Bob", code);
    await alice.locator(".notes-prose").click();
    await alice.keyboard.type("From Alice.");
    await expect(bob.locator(".notes-prose")).toContainText("From Alice.");
    await bob.locator(".notes-prose").click();
    await bob.keyboard.press("Control+End");
    await bob.keyboard.type(" From Bob.");
    await expect(alice.locator(".notes-prose")).toContainText("From Bob.");

    await alice.getByRole("button", { name: /^Undo/ }).click();
    await expect(alice.locator(".notes-prose")).not.toContainText("From Alice.");
    await expect(alice.locator(".notes-prose")).toContainText("From Bob.");
  });

  test("an upload gets its own section, which fills in when the job finishes", async ({ browser }) => {
    // The rule-based cleanup is deterministic, so the result is known exactly.
    const { page: alice, code } = await openNotes(browser, "Alice");
    const { page: bob } = await openNotes(browser, "Bob", code);

    await alice.getByRole("button", { name: "Add media" }).click();
    await addToRoom(alice, [{ text: "teh group met on thursday", strategy: "rulebased" }]);

    // Everyone in the room sees the section, then its result, with no reload.
    const section = bob.locator(".doc-section");
    await expect(section).toHaveCount(1);
    await expect(section.locator(".doc-section-title")).toHaveText("teh group met on thursday");
    await expect(section.locator(".doc-section-status")).toHaveText("Added to notes", { timeout: 60_000 });
    await expect(section.locator(".doc-section-body")).toContainText("The group met on thursday.");

    // The section is part of the notes: the outline lists it, and people can
    // write in it like anywhere else.
    await expect(bob.locator(".gdoc-outline")).toContainText("teh group met on thursday");
    await section.locator(".doc-section-body p").last().click();
    await bob.keyboard.press("End");
    await bob.keyboard.type(" (Bob: confirmed)");
    await expect(alice.locator(".doc-section-body")).toContainText("(Bob: confirmed)");

    // Open jumps to the upload's card in the feed.
    await alice.getByRole("button", { name: "Open", exact: true }).click();
    await expect(alice.getByRole("button", { name: "Feed", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator(".job-card").first()).toBeFocused();
  });
});

test("words typed while the connection is down reach the room once it is back", async ({ page }) => {
  // Regression: a dropped connection took the whole room view down until the
  // snapshot came back, unmounting the editor and destroying its document -
  // and with it anything typed that the server had not yet received.
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const w = window as unknown as { __sockets: WebSocket[] };
    w.__sockets = [];
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        w.__sockets.push(this);
      }
    } as typeof WebSocket;
  });
  await page.goto("/");
  await page.getByRole("button", { name: /create session/i }).click();
  await page.getByPlaceholder("Ada").fill("Alice");
  await page.getByRole("button", { name: /join session/i }).click();
  await openRoomNotes(page);
  const prose = page.locator(".notes-prose");
  await prose.click();
  await page.keyboard.type("Before the drop. ");
  await expect(page.locator(".gdoc-save")).toHaveClass(/is-synced/);

  // Cut the socket, and keep typing straight away, while it is down.
  await page.evaluate(() => (window as unknown as { __sockets: WebSocket[] }).__sockets.at(-1)!.close(4000, "test drop"));
  await page.keyboard.type("Typed while offline.");
  // The editor stayed put: focus and the words are still there.
  await expect(prose).toBeFocused();
  await expect(prose).toContainText("Typed while offline.");
  await expect(page.locator(".gdoc-save")).toHaveClass(/is-synced/, { timeout: 20_000 });

  // A fresh page load reads the room's own copy.
  await page.reload();
  await openRoomNotes(page);
  await expect(page.locator(".notes-prose")).toContainText("Before the drop. Typed while offline.");
});
