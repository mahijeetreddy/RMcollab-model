import { expect, test, type Browser, type Page } from "@playwright/test";
import { openRoomNotes } from "../ui.js";

/** Invite links, the private device link, handing over, ending a session, chat deletion, privacy, webhooks. */

const API = "http://localhost:4000";

async function start(page: Page, name = "Alice"): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: /create session/i }).click();
  await page.getByPlaceholder("Ada").fill(name);
  await page.getByRole("button", { name: /join session/i }).click();
  await openRoomNotes(page);
  return (await page.locator(".code-chip").textContent())!.trim();
}

async function join(browser: Browser, code: string, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/join/${code}`);
  await page.getByPlaceholder("Ada").fill(name);
  await page.getByRole("button", { name: /join session/i }).click();
  await expect(page.locator("#room-heading")).toHaveText("Main Room");
  return page;
}

const meId = (page: Page) =>
  page.evaluate(() => (JSON.parse(window.sessionStorage.getItem("rmcollab.credentials") ?? "{}") as { participantId?: string }).participantId ?? "");

test("an invite link opens the join screen with the code filled in", async ({ page, browser }) => {
  const code = await start(page);
  await page.locator(".code-chip").click();
  await expect(page.getByRole("dialog", { name: "Invite people" })).toBeVisible();

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`/join/${code}`);
  await expect(guest.getByLabel("Session code")).toHaveValue(code);
  await expect(guest.locator(".landing-invite")).toContainText("You've been invited");
  await expect(guest.getByPlaceholder("Ada")).toBeFocused();
  await guest.getByPlaceholder("Ada").fill("Bob");
  await guest.getByRole("button", { name: /join session/i }).click();
  await expect(guest.locator("#room-heading")).toHaveText("Main Room");
  // Used, so the address goes back to plain.
  await expect(guest).toHaveURL(/\/$/);
});

test("the private device link continues as the owner, with the owner's controls", async ({ page, browser }) => {
  const code = await start(page);
  const id = await meId(page);
  expect(id).not.toBe("");
  const other = await (await browser.newContext()).newPage();
  await other.goto(`/join/${code}#as=${id}`);
  await expect(other.locator(".landing-invite")).toContainText("continues as someone");
  await other.getByPlaceholder("Ada").fill("Alice on her phone");
  await other.getByRole("button", { name: /join session/i }).click();
  await expect(other.locator("#room-heading")).toHaveText("Main Room");
  // The same person: owner controls, and still one participant.
  await expect(other.getByRole("switch", { name: /waiting room/i })).toBeVisible();
  expect(await meId(other)).toBe(id);
});

test("the owner can hand the session over", async ({ page, browser }) => {
  const code = await start(page);
  const bob = await join(browser, code, "Bob");
  await expect(bob.getByRole("switch", { name: /waiting room/i })).toHaveCount(0);

  await page.getByRole("button", { name: "Make Bob the owner" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Make owner" }).click();

  await expect(bob.locator(".removed-notice")).toContainText("Alice made you the owner of this session.");
  await expect(bob.getByRole("switch", { name: /waiting room/i })).toBeVisible();
  await expect(page.getByRole("switch", { name: /waiting room/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove Bob" })).toHaveCount(0);
});

test("ending a session sends everyone back to the start and deletes it", async ({ page, browser, request }) => {
  const code = await start(page);
  const bob = await join(browser, code, "Bob");
  await expect(bob.locator(".end-session-button")).toHaveCount(0);

  await page.getByRole("button", { name: "End session…" }).click();
  await page.getByRole("button", { name: "End and delete everything" }).click();

  for (const p of [page, bob]) {
    await expect(p.locator(".landing-notice")).toHaveText("Alice ended the session. Everything in it has been deleted.");
  }
  // Everyone is told first, then the rows go: wait for the deletion to land.
  await expect
    .poll(async () => (await request.get(`${API}/api/sessions/${code.replace("-", "")}`)).status(), { timeout: 10_000 })
    .toBe(404);
});

test("a message can be deleted by whoever wrote it, or by the owner", async ({ page, browser }) => {
  const code = await start(page);
  const bob = await join(browser, code, "Bob");
  await page.locator(".chat-toggle").click();
  await bob.locator(".chat-toggle").click();
  await bob.getByLabel(/message the room/i).fill("first from bob");
  await bob.getByLabel(/message the room/i).press("Enter");
  await page.getByLabel(/message the room/i).fill("from alice");
  await page.getByLabel(/message the room/i).press("Enter");
  await expect(bob.getByText("from alice", { exact: true })).toBeVisible();

  // Bob may delete his own, not Alice's.
  await expect(bob.getByRole("button", { name: "Delete message from Alice" })).toHaveCount(0);
  // Alice, the owner, may delete Bob's.
  await page.getByRole("button", { name: "Delete message from Bob" }).click({ force: true });
  await page.getByRole("alertdialog", { name: "Delete this message?" }).getByRole("button", { name: "Delete" }).click();
  for (const p of [page, bob]) await expect(p.getByText("first from bob", { exact: true })).toHaveCount(0);
  await expect(bob.getByText("from alice", { exact: true })).toBeVisible();
});

test("the privacy page says what happens to what people put in, and is linked from the start", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "How your data is handled" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { name: "Privacy", level: 1 })).toBeVisible();
  for (const heading of ["No accounts", "What is kept, and for how long", "Who else sees it", "In your browser"]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  await expect(page.getByText("3 days")).toBeVisible();
});

test("webhooks are the owner's to manage, and nobody else's", async ({ page, browser, request }) => {
  const code = await start(page);
  const bob = await join(browser, code, "Bob");
  const owner = await meId(page);
  const member = await meId(bob);
  const url = `${API}/api/sessions/${code.replace("-", "")}/webhooks`;
  const target = "http://host.docker.internal:9/hook";

  expect((await request.post(url, { data: { url: target } })).status()).toBe(403);
  expect((await request.post(url, { data: { url: target, participantId: member } })).status()).toBe(403);
  expect((await request.get(`${url}?participantId=${member}`)).status()).toBe(403);
  const created = await request.post(url, { data: { url: target, participantId: owner } });
  expect(created.status()).toBe(201);
  const { endpoint } = (await created.json()) as { endpoint: { id: string } };
  expect((await request.get(`${API}/api/webhooks/${endpoint.id}/deliveries`)).status()).toBe(403);
  expect((await request.delete(`${API}/api/webhooks/${endpoint.id}?participantId=${member}`)).status()).toBe(403);
  expect((await request.delete(`${API}/api/webhooks/${endpoint.id}?participantId=${owner}`)).status()).toBe(200);
});
