import { expect, test, type Page } from "@playwright/test";
import { addToRoom, openRoomNotes } from "../ui.js";

/**
 * The layout at every width a window is likely to be dragged to: nothing may
 * scroll sideways or spill out of the window, the sidebar becomes a drawer on a
 * phone, and the notes outline follows the width. One live page is resized, as
 * dragging the window edge does. AUDIT_OUT=<dir> also saves a screenshot per
 * view and width, for looking at what the assertions cannot judge.
 */
const OUT = process.env.AUDIT_OUT;
const WIDTHS = [1440, 1280, 1024, 900, 768, 600, 390];

/**
 * Crossing a breakpoint starts transitions (the sidebar sliding into a drawer),
 * and mid-slide it is briefly outside the window. Measure once they are done,
 * rather than after a guessed pause. Only transitions: a looping animation
 * (a spinner) never ends.
 */
async function settled(page: Page) {
  await page.waitForTimeout(50);
  await page.waitForFunction(
    () => document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === "running").length === 0,
    undefined,
    { timeout: 5_000 },
  );
}

/** Elements whose box leaves the window horizontally, and any sideways page scroll. */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const pageScroll = document.documentElement.scrollWidth - vw;
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement | SVGElement>("body *"))) {
      // SVG internals are judged by their outermost <svg>.
      if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Inside a scrolling or clipping container that itself fits the window
      // is fine (a sideways-scrolling toolbar, a scrollable panel): only what
      // actually shows outside the window counts.
      let clipped = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (p instanceof SVGElement) continue;
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) {
          const pr = p.getBoundingClientRect();
          if (pr.right <= vw + 1 && pr.left >= -1) clipped = true;
          break;
        }
      }
      if (clipped) continue;
      if (r.right > vw + 1 || r.left < -1) {
        const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : "";
        offenders.push(`${el.tagName.toLowerCase()}${cls} [${Math.round(r.left)}..${Math.round(r.right)}]`);
      }
    }
    return { pageScroll, offenders: offenders.slice(0, 8) };
  });
}

test("every view fits the window at every width, from desktop to phone", async ({ page }) => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  const check = async (view: string) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 900 });
      await settled(page);
      const o = await overflow(page);
      if (o.pageScroll > 0 || o.offenders.length > 0) {
        problems.push(
          `${view} at ${width}px: sideways scroll ${o.pageScroll}px; outside the window: ${o.offenders.join(" | ") || "-"}`,
        );
      }
      if (OUT) await page.screenshot({ path: `${OUT}/${view}-${width}.png` });
    }
  };

  await page.goto("/");
  await expect(page.getByRole("button", { name: /create session/i })).toBeVisible();
  await check("landing");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: /create session/i }).click();
  await expect(page.getByLabel("Session code")).toHaveValue(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  await page.getByPlaceholder("Ada").fill("Alice");
  await page.getByRole("button", { name: /join session/i }).click();
  await openRoomNotes(page);

  // Content, so each view is laid out with something in it.
  await page.locator(".notes-prose").click();
  await page.keyboard.type("Distributed systems study group");
  await page.getByLabel("Paragraph style").selectOption("h1");
  await page.getByRole("button", { name: "Add media" }).click();
  await addToRoom(page, [{ text: "teh group met on thursday and agreed to use redis streams", strategy: "rulebased" }]);
  await expect(page.locator(".doc-section-status")).toHaveText("Added to notes", { timeout: 60_000 });
  await page.getByRole("button", { name: "Add media" }).click();
  await check("notes");

  // The outline follows the window: closed when narrow, back when wide.
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(page.locator(".gdoc-outline")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".gdoc-outline")).toBeVisible();

  // Phone: the sidebar is a drawer - hidden until asked for, closed by Escape.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#room-nav")).toBeHidden();
  await page.getByRole("button", { name: /rooms/i, expanded: false }).click();
  await expect(page.locator("#room-nav")).toBeVisible();
  await settled(page);
  if (OUT) await page.screenshot({ path: `${OUT}/drawer-390.png` });
  await page.keyboard.press("Escape");
  await expect(page.locator("#room-nav")).toBeHidden();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await expect(page.locator(".diff-summary")).toBeVisible();
  await check("feed");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByLabel(/search this room's documents/i).fill("redis");
  await expect(page.locator(".library-entry")).toHaveCount(1);
  await check("library");

  expect(problems, problems.join("\n")).toEqual([]);
});
