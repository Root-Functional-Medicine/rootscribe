import { test, expect } from "@playwright/test";

// Journey: inbox-zero workflow — mark reviewed, archive, snooze, unsnooze.
// Uses rec-new-01 (a plain "new" recording) and rec-snoozed-01 (already
// snoozed in the fixture). Each test starts from a clean DB snapshot.

test.beforeEach(async ({ request }) => {
  await request.post("/api/_test/reset");
});

test.describe("Inbox review workflow", () => {
  test("Mark Reviewed transitions a new recording's inbox status", async ({ page }) => {
    await page.goto("/recordings/rec-new-01");

    await page.getByRole("button", { name: /mark reviewed/i }).click();

    // After the mutation resolves, the primary action button swaps from
    // "Mark Reviewed" to "Reviewed" (disabled) — that label flip is the
    // most robust visible signal the status changed.
    await expect(
      page.getByRole("button", { name: /^reviewed$/i }),
    ).toBeDisabled();
  });

  test("Archive removes the recording from the default Dashboard view", async ({ page }) => {
    await page.goto("/recordings/rec-new-01");

    await page.getByRole("button", { name: /^archive$/i }).click();
    // Wait for the mutation to settle by waiting for the Reopen button to
    // appear — it only renders for reviewed/archived items.
    await expect(
      page.getByRole("button", { name: /reopen/i }),
    ).toBeVisible();

    // Back on the Dashboard, the row should still be findable via the
    // Archived filter but NOT via default All (which shows everything
    // including archived — so switch filter to Active to verify it's out
    // of the inbox-zero view).
    await page.goto("/");
    await page.getByRole("button", { name: /^active$/i }).click();
    await expect(page.getByText("standup 2026-04-12")).toHaveCount(0);
  });

  test("fast-forward-snooze + page reload surfaces a snoozed recording back into the inbox", async ({
    page,
    request,
  }) => {
    // rec-snoozed-01 starts with snoozed_until ~7 days out; the /api/_test/
    // fast-forward-snooze handler shifts that into the past so the
    // effective status flips back to "new" on the next query.
    await request.post("/api/_test/fast-forward-snooze", {
      data: { recordingId: "rec-snoozed-01" },
    });

    await page.goto("/");
    await page.getByRole("button", { name: /^active$/i }).click();

    // After fast-forward, the previously-snoozed row should be in the
    // Active view. (The fixture also has 3 other non-snoozed "new" rows
    // visible, so we assert the snoozed one is present rather than a
    // specific count.)
    await expect(page.getByText("Q2 planning draft")).toBeVisible();
  });
});
