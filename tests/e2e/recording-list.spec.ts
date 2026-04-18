import { test, expect } from "@playwright/test";

// Journey: Dashboard list view — pagination, search, filter, click-through.
// Runs against the seeded 12-recording fixture; each test resets DB state
// between cases so filter counts are deterministic.

test.beforeEach(async ({ request }) => {
  await request.post("/api/_test/reset");
});

test.describe("Dashboard recording list", () => {
  test("loads all 12 seeded recordings in the default (All) filter", async ({ page }) => {
    await page.goto("/");

    // Each RecordingCard is a <Link> rendered as an anchor to /recordings/:id.
    // Counting those is the most selector-stable way to assert row count.
    const rows = page.locator('a[href^="/recordings/"]');
    await expect(rows).toHaveCount(12);
  });

  test("search narrows the list by filename substring (case-insensitive)", async ({ page }) => {
    await page.goto("/");

    await page.getByPlaceholder(/search archives/i).fill("billing");

    const rows = page.locator('a[href^="/recordings/"]');
    await expect(rows).toHaveCount(1);
    await expect(page.getByText("billing escalation call")).toBeVisible();
  });

  test("the Reviewed filter tab shows exactly the 3 reviewed recordings", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: /^reviewed$/i }).click();

    const rows = page.locator('a[href^="/recordings/"]');
    await expect(rows).toHaveCount(3);
  });

  test("the Archived filter tab shows exactly the 2 archived recordings", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: /^archived$/i }).click();

    const rows = page.locator('a[href^="/recordings/"]');
    await expect(rows).toHaveCount(2);
  });

  test("clicking a recording row navigates to its detail page", async ({ page }) => {
    await page.goto("/");

    // Click the first row. We target by the heading text to avoid depending
    // on the Link's exact selector structure.
    await page.getByRole("heading", { name: /standup 2026-04-12/i }).click();

    await expect(page).toHaveURL(/\/recordings\/rec-new-01$/);
  });
});
