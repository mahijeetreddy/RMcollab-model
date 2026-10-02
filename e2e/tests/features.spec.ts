import { expect, test, type Page } from "@playwright/test";
import { addToRoom, clearLimit, openRoomNotes } from "../ui.js";

/** The sample room, recent sessions, renaming and deleting from the feed, and notes history. */

const clearCodeMisses = () => clearLimit("code-miss");

// AUDIT_OUT=<dir> keeps screenshots of each state, for reviewing the design.
const OUT = process.env.AUDIT_OUT;
const shot = async (page: Page, name: string) => {
  if (OUT) await page.screenshot({ path: `${OUT}/${name}.png` });
};

async function newRoom(page: Page, name = "Alice") {
  await page.goto("/");
  await page.getByRole("button", { name: /create session/i }).click();
  await expect(page.getByLabel("Session code")).toHaveValue(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  await page.getByPlaceholder("Ada").fill(name);
  await page.getByRole("button", { name: /join session/i }).click();
  await openRoomNotes(page);
}

test("the sample room opens already analysed, and Ask works on it", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByPlaceholder("Ada").fill("Sam");
  clearLimit("demo");
  await page.getByRole("button", { name: "Try a sample room" }).click();
  await openRoomNotes(page);
  await expect(page.locator(".notes-prose h2").first()).toHaveText("Welcome to the sample room");
  // Three uploads, each with its section filled in.
  await expect(page.locator(".doc-section-status")).toHaveText(["Added to notes", "Added to notes", "Added to notes"]);
  await expect(page.locator(".notes-prose")).toContainText("Redis Streams > Kafka");
  await shot(page, "demo-notes");

  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await expect(page.locator(".job-card")).toHaveCount(3);
  await expect(page.locator(".job-title")).toContainText(["whiteboard.jpg", "lecture.mp3", "Week 6 planning meeting"]);
  await shot(page, "demo-feed");

  // The sample material's passages are embedded like any room's.
  await page.locator(".ask-toggle").click();
  const input = page.getByRole("textbox", { name: "Ask the room" });
  await input.fill("Why did we pick Redis Streams over Kafka?");
  await input.press("Enter");
  const turn = page.locator(".ask-turn").last();
  await expect(turn).toHaveAttribute("aria-busy", "false", { timeout: 90_000 });
  await expect(turn.locator(".ask-sources").first()).toContainText(/Week 6 planning meeting|whiteboard\.jpg/);
  await shot(page, "demo-ask");
});

test("a recent session rejoins as the same person, who can still manage their uploads", async ({ page }) => {
  test.setTimeout(120_000);
  await newRoom(page);
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await addToRoom(page, [{ text: "Broker decision\nWe chose Redis Streams.", strategy: "rulebased" }]);
  await expect(page.locator(".job-title")).toHaveText("Broker decision");

  // Rename from the card's menu.
  await page.getByRole("button", { name: "Actions for Broker decision" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const name = page.getByRole("textbox", { name: "Upload name", exact: true });
  await name.fill("Why Redis Streams");
  await name.press("Enter");
  await expect(page.locator(".job-title")).toHaveText("Why Redis Streams");
  await shot(page, "feed-renamed");

  // Leave, and come back from Recent sessions.
  await page.getByRole("button", { name: "Leave" }).click();
  const recent = page.locator(".recent-item").first();
  await expect(recent).toContainText("as Alice");
  await shot(page, "landing-recent");
  await recent.locator(".recent-open").click();
  // Back where they were: the room, in the view they last used.
  await expect(page.locator("#room-heading")).toHaveText("Main Room");
  await page.getByRole("button", { name: "Feed", exact: true }).click();

  // Still the uploader: the menu is offered, and delete works.
  await page.getByRole("button", { name: "Actions for Why Redis Streams" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await shot(page, "feed-delete-confirm");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".job-card")).toHaveCount(0);
});

test("notes history keeps what was there before a large deletion, and restores it", async ({ page }) => {
  test.setTimeout(120_000);
  await newRoom(page);
  await page.locator(".notes-prose").click();
  await page.keyboard.type("# Decisions");
  await page.keyboard.press("Enter");
  const long = "We chose Redis Streams over Kafka because nobody wants to run ZooKeeper for a class project. ";
  for (let i = 0; i < 6; i += 1) await page.keyboard.type(long, { delay: 0 });
  // Saved, then wiped: select everything and delete it.
  await page.waitForTimeout(1500);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await expect(page.locator(".notes-prose")).not.toContainText("ZooKeeper");
  await page.waitForTimeout(1500);

  await page.getByRole("button", { name: "History" }).click();
  const item = page.locator(".history-item", { hasText: "Before a large deletion" });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator(".history-preview-doc")).toContainText("ZooKeeper");
  await shot(page, "history");
  await page.getByRole("button", { name: "Restore this version" }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator(".history")).toHaveCount(0);
  await expect(page.locator(".notes-prose")).toContainText("ZooKeeper");
  await expect(page.locator(".notes-prose h1")).toHaveText("Decisions");

  // The restore is itself undoable: what was there just before it is in the list.
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.locator(".history-item").first()).toContainText("restored an earlier version");
});

test("deleting a breakout room moves everyone in it to the main room", async ({ page, browser }) => {
  await newRoom(page, "Alice");
  const code = (await page.locator(".code-chip").textContent())!.trim();
  await page.getByLabel(/new breakout room name/i).fill("Group A");
  await page.getByRole("button", { name: /^add$/i }).click();
  await expect(page.locator("#room-heading")).toHaveText("Group A");

  const bob = await (await browser.newContext()).newPage();
  await bob.goto("/");
  await bob.getByLabel("Session code").fill(code);
  await bob.getByPlaceholder("Ada").fill("Bob");
  await bob.getByRole("button", { name: /join session/i }).click();
  await bob.getByRole("button", { name: /Group A/ }).click();
  await expect(bob.locator("#room-heading")).toHaveText("Group A");

  // Only the owner is offered it, and it asks first.
  await expect(bob.getByRole("button", { name: "Delete this room" })).toHaveCount(0);
  await page.getByRole("button", { name: "Delete this room" }).click();
  await page.getByRole("button", { name: "Delete room" }).click();

  for (const p of [page, bob]) {
    await expect(p.locator("#room-heading")).toHaveText("Main Room");
    await expect(p.getByRole("button", { name: /Group A/ })).toHaveCount(0);
  }
  // Both moved at once, so each one's arrival raced the other's snapshot of
  // the main room: Bob used to be missing from Alice's list.
  await expect(page.locator(".participants")).toContainText("Bob");
  await expect(bob.locator(".participants")).toContainText("Alice");
  // And Bob is told why he moved; Alice, who did it, is not.
  await expect(bob.locator(".removed-notice")).toContainText('Alice deleted "Group A"');
  await expect(page.locator(".removed-notice")).toHaveCount(0);
});

test("someone open in two tabs stays in the room when they close one", async ({ page, browser }) => {
  await newRoom(page, "Alice");
  const code = (await page.locator(".code-chip").textContent())!.trim();
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await bob.goto("/");
  await bob.getByLabel("Session code").fill(code);
  await bob.getByPlaceholder("Ada").fill("Bob");
  await bob.getByRole("button", { name: /join session/i }).click();
  await expect(bob.locator("#room-heading")).toHaveText("Main Room");
  const bobId = await bob.evaluate(
    () => (JSON.parse(window.sessionStorage.getItem("rmcollab.credentials") ?? "{}") as { participantId?: string }).participantId,
  );
  // The same Bob on a second device, through his private link.
  const phone = await (await browser.newContext()).newPage();
  await phone.goto(`/join/${code}#as=${bobId}`);
  await phone.getByPlaceholder("Ada").fill("Bob");
  await phone.getByRole("button", { name: /join session/i }).click();
  await expect(phone.locator("#room-heading")).toHaveText("Main Room");

  await bobContext.close();
  // Give the gateway its moment to process the close, then: Bob is still here.
  await page.waitForTimeout(1500);
  await expect(page.locator(".participants")).toContainText("Bob");
  // Gone only when his last connection goes.
  await phone.context().close();
  await expect(page.locator(".participants")).not.toContainText("Bob");
});

async function joinAs(browser: import("@playwright/test").Browser, code: string, name: string) {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByLabel("Session code").fill(code);
  await page.getByPlaceholder("Ada").fill(name);
  await page.getByRole("button", { name: /join session/i }).click();
  await expect(page.locator("#room-heading")).toHaveText("Main Room");
  return page;
}

test("a room holds several documents, each edited live and kept apart", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByRole("button", { name: /create session/i }).click();
  await expect(page.getByLabel("Session code")).toHaveValue(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  const code = await page.getByLabel("Session code").inputValue();
  await page.getByPlaceholder("Ada").fill("Alice");
  await page.getByRole("button", { name: /join session/i }).click();

  // Notes opens on the room's documents; its own notes are always there.
  await expect(page.locator(".docs-home")).toBeVisible();
  await expect(page.locator(".doc-card.is-main")).toContainText("Room notes");
  await expect(page.locator(".doc-card.is-main")).toContainText("Uploads land here");
  await shot(page, "docs-home-empty");

  const bob = await joinAs(browser, code, "Bob");
  await bob.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(bob.locator(".docs-home")).toBeVisible();

  // A new document opens straight away, and appears for Bob without a reload.
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page.locator("#notes-heading")).toHaveText("Untitled document");
  await page.locator(".notes-prose").click();
  await page.keyboard.type("Exam plan: chapters 1 to 6, then past papers.");
  await expect(bob.locator(".doc-card")).toHaveCount(2);
  await bob.locator(".doc-card", { hasText: "Untitled document" }).locator(".doc-card-open").click();
  await expect(bob.locator(".notes-prose")).toContainText("Exam plan: chapters 1 to 6");

  // Kept apart: Room notes does not have it.
  await page.getByRole("button", { name: "All documents" }).click();
  await page.locator(".doc-card.is-main .doc-card-open").click();
  await expect(page.locator(".gdoc-save")).toContainText("Saved to the room");
  await expect(page.locator(".notes-prose")).not.toContainText("Exam plan");

  // Rename from the list: Bob, in the document, sees its new name.
  await page.getByRole("button", { name: "All documents" }).click();
  await page.getByRole("button", { name: "Actions for Untitled document" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const name = page.getByRole("textbox", { name: "Document name" });
  await name.fill("Exam plan");
  await name.press("Enter");
  await expect(bob.locator("#notes-heading")).toHaveText("Exam plan");
  await shot(page, "docs-home");

  // Ask finds it there, and its citation opens the document.
  await page.locator(".ask-toggle").click();
  const input = page.getByRole("textbox", { name: "Ask the room" });
  await input.fill("Which chapters are in the exam plan?");
  await input.press("Enter");
  const turn = page.locator(".ask-turn").last();
  await expect(turn).toHaveAttribute("aria-busy", "false", { timeout: 90_000 });
  const source = turn.locator(".ask-source", { hasText: "Exam plan" }).first();
  await expect(source).toBeVisible();
  await source.click();
  await expect(page.locator("#notes-heading")).toHaveText("Exam plan");
  await page.locator(".ask-close").click();

  // Deleted: gone from both lists; Bob, inside it, goes back to the list.
  await page.getByRole("button", { name: "All documents" }).click();
  await page.getByRole("button", { name: "Actions for Exam plan" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".doc-card")).toHaveCount(1);
  // Bob was inside it: taken back to the list by itself and told why, rather
  // than left typing into a document that no longer exists.
  await expect(bob.locator(".removed-notice")).toContainText("That document was deleted.");
  await expect(bob.locator(".doc-card")).toHaveCount(1);
});

test("the owner can remove someone from a breakout room, and from the session", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await newRoom(page, "Alice");
  const code = (await page.locator(".code-chip").textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);

  // Out of a breakout room: moved to the main room, and kept out of that one.
  await page.getByLabel(/new breakout room name/i).fill("Group A");
  await page.getByRole("button", { name: /^add$/i }).click();
  await expect(page.locator("#room-heading")).toHaveText("Group A");
  const bob = await joinAs(browser, code, "Bob");
  await bob.getByRole("button", { name: /Group A/ }).click();
  await expect(bob.locator("#room-heading")).toHaveText("Group A");
  await page.getByRole("button", { name: "Remove Bob" }).click();
  await shot(page, "remove-confirm");
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(bob.locator("#room-heading")).toHaveText("Main Room");
  await expect(bob.locator(".removed-notice")).toContainText('Alice removed you from "Group A"');
  await bob.getByRole("button", { name: /Group A/ }).click();
  await expect(bob.locator("#room-heading")).toHaveText("Main Room");

  // Out of the main room: out of the session, back to the start, told why.
  await page.getByRole("button", { name: /Main Room/ }).click();
  await expect(page.locator("#room-heading")).toHaveText("Main Room");
  await page.getByRole("button", { name: "Remove Bob" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(bob.locator(".landing-notice")).toHaveText("Alice removed you from the session.");
  await expect(bob.getByRole("button", { name: /create session/i })).toBeVisible();

  // The session's code changed, so the one Bob knows lets nobody new in.
  const notice = page.locator(".new-code");
  await expect(notice).toContainText("so Bob can't come back with the old one");
  const newCode = (await notice.locator("code").textContent())!.trim();
  expect(newCode).not.toBe(code);
  await expect(page.locator(".code-chip")).toHaveText(newCode);
  await bob.getByLabel("Session code").fill(code);
  await bob.getByPlaceholder("Ada").fill("Robert");
  await bob.getByRole("button", { name: /join session/i }).click();
  await expect(bob.getByText(/No session with code/)).toBeVisible();
  clearCodeMisses();
  // Alice herself still comes back after a reload, whatever code her tab holds.
  await page.reload();
  await expect(page.locator("#room-heading")).toHaveText("Main Room");

  // Only the owner is offered it.
  const carol = await joinAs(browser, newCode, "Carol");
  await expect(carol.getByRole("button", { name: "Remove Alice" })).toHaveCount(0);
  await expect(carol.getByRole("switch", { name: /waiting room/i })).toHaveCount(0);
});

test("with the waiting room on, newcomers wait until the owner lets them in", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await newRoom(page, "Alice");
  const code = (await page.locator(".code-chip").textContent())!.trim();
  const early = await joinAs(browser, code, "Early");
  await page.getByRole("switch", { name: /waiting room/i }).check();
  await expect(page.getByRole("switch", { name: /waiting room/i })).toBeChecked();

  // Someone new waits, seeing nothing of the session.
  const dan = await (await browser.newContext()).newPage();
  await dan.goto("/");
  await dan.getByLabel("Session code").fill(code);
  await dan.getByPlaceholder("Ada").fill("Dan");
  await dan.getByRole("button", { name: /join session/i }).click();
  await expect(dan.getByRole("heading", { name: "Waiting to be let in" })).toBeVisible();
  await expect(dan.getByText("Alice will let you into")).toBeVisible();
  await expect(dan.locator("#room-heading")).toHaveCount(0);
  // Only the owner is asked.
  const request = page.getByRole("group", { name: "Dan wants to join" });
  await expect(request).toBeVisible();
  await shot(page, "waiting-room-request");
  await expect(early.getByRole("group", { name: /wants to join/ })).toHaveCount(0);
  await request.getByRole("button", { name: "Admit" }).click();
  await expect(dan.locator("#room-heading")).toHaveText("Main Room");
  await expect(request).toHaveCount(0);
  // Once let in, a reload comes straight back.
  await dan.reload();
  await expect(dan.locator("#room-heading")).toHaveText("Main Room");

  // Turned away: back to the start, told why.
  const eve = await (await browser.newContext()).newPage();
  await eve.goto("/");
  await eve.getByLabel("Session code").fill(code);
  await eve.getByPlaceholder("Ada").fill("Eve");
  await eve.getByRole("button", { name: /join session/i }).click();
  await expect(eve.getByRole("heading", { name: "Waiting to be let in" })).toBeVisible();
  await page.getByRole("group", { name: "Eve wants to join" }).getByRole("button", { name: "Deny" }).click();
  await expect(eve.locator(".landing-notice")).toHaveText("Alice didn't let you into the session.");
  await expect(page.getByRole("button", { name: "Remove Eve" })).toHaveCount(0);
});

test("session codes are ten characters, typed any way, and guessing is limited", async ({ page, request }) => {
  // The limit applies to this machine's real address (the load balancer does
  // not trust a forwarded header), so the counter is cleared afterwards or
  // every later test would be refused.
  await newRoom(page, "Alice");
  const shown = (await page.locator(".code-chip").textContent())!.trim();
  const raw = shown.replace("-", "");
  expect(raw).toMatch(/^[A-Z0-9]{10}$/);
  // Lower case and without the dash still finds it.
  const found = await request.get(`http://localhost:4000/api/sessions/${raw.toLowerCase()}`);
  expect(found.status()).toBe(200);
  // Enough wrong guesses from one address are refused for a while.
  let refused = 0;
  for (let i = 0; i < 25; i += 1) {
    const r = await request.get(`http://localhost:4000/api/sessions/NOPE${String(i).padStart(6, "0")}`, {
      headers: { "X-Forwarded-For": "203.0.113.77" },
    });
    if (r.status() === 429) refused += 1;
  }
  clearCodeMisses();
  expect(refused).toBeGreaterThan(0);
});

test("moving into a room with chat history does not count its history as unread", async ({ page, browser }) => {
  await newRoom(page, "Alice");
  const code = (await page.locator(".code-chip").textContent())!.trim();
  await page.getByLabel(/new breakout room name/i).fill("Group B");
  await page.getByRole("button", { name: /^add$/i }).click();
  await expect(page.locator("#room-heading")).toHaveText("Group B");
  const bob = await joinAs(browser, code, "Bob");
  await bob.getByRole("button", { name: /Group B/ }).click();
  await expect(bob.locator("#room-heading")).toHaveText("Group B");
  // Alice steps out; Bob talks in Group B meanwhile.
  await page.getByRole("button", { name: /Main Room/ }).click();
  await expect(page.locator("#room-heading")).toHaveText("Main Room");
  await bob.locator(".chat-toggle").click();
  for (const words of ["one", "two", "three"]) {
    await bob.getByLabel(/message the room/i).fill(words);
    await bob.getByLabel(/message the room/i).press("Enter");
  }
  await expect(bob.getByText("three", { exact: true })).toBeVisible();

  // Back into Group B, chat closed: three old messages are history, not news.
  await page.getByRole("button", { name: /Group B/ }).click();
  await expect(page.locator("#room-heading")).toHaveText("Group B");
  await page.waitForTimeout(500);
  await expect(page.locator(".chat-unread")).toHaveCount(0);
  // A new one is.
  await bob.getByLabel(/message the room/i).fill("four");
  await bob.getByLabel(/message the room/i).press("Enter");
  await expect(page.locator(".chat-unread")).toContainText("1");
});

test("the session's owner can manage a breakout room someone else made", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await newRoom(page, "Alice");
  const code = (await page.locator(".code-chip").textContent())!.trim();
  const bob = await joinAs(browser, code, "Bob");
  await bob.getByLabel(/new breakout room name/i).fill("Bob's room");
  await bob.getByRole("button", { name: /^add$/i }).click();
  await expect(bob.locator("#room-heading")).toHaveText("Bob's room");
  const carol = await joinAs(browser, code, "Carol");
  await carol.getByRole("button", { name: /Bob's room/ }).click();
  await expect(carol.locator("#room-heading")).toHaveText("Bob's room");

  await page.getByRole("button", { name: /Bob's room/ }).click();
  await expect(page.locator("#room-heading")).toHaveText("Bob's room");
  // Carol can be removed from it; Bob, whose room it is, cannot - but the room can go.
  await expect(page.getByRole("button", { name: "Remove Carol" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Bob" })).toHaveCount(0);
  await page.getByRole("button", { name: "Delete this room" }).click();
  await page.getByRole("button", { name: "Delete room" }).click();
  for (const p of [page, bob, carol]) await expect(p.locator("#room-heading")).toHaveText("Main Room");
  await expect(carol.locator(".removed-notice")).toContainText(`Alice deleted "Bob's room"`);
});
