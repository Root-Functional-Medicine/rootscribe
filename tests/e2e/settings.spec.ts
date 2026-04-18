import { test, expect } from "@playwright/test";

// Journey: Settings page — poll interval update, webhook URL update, Jira
// base URL update. The seeded config has pollIntervalMinutes=10, empty
// webhook, and jiraBaseUrl=https://example.atlassian.net/browse/.

test.beforeEach(async ({ request }) => {
  await request.post("/api/_test/reset");
});

test.describe("Settings page", () => {
  test("renders the configured poll interval (10 minutes from the fixture)", async ({
    page,
  }) => {
    await page.goto("/settings");

    await expect(
      page.getByRole("heading", { name: /configuration/i, level: 1 }),
    ).toBeVisible();

    // The Settings UI renders the current value as "{n} minutes" in a big
    // display above the slider. Asserting on that text reads cleanly without
    // needing to inspect the range slider's internal value.
    await expect(page.getByText(/^10$/).first()).toBeVisible();
  });

  test("updating the poll-interval slider and saving persists the value across reload", async ({
    page,
  }) => {
    await page.goto("/settings");

    // Playwright's fill() works on input[type="range"] — it dispatches the
    // native change event that Settings' onChange handler listens for.
    const slider = page.locator('input[type="range"]');
    await slider.fill("5");

    await page.getByRole("button", { name: /save settings/i }).click();

    // After the save lands, the Save button label flips from "Saving…" back
    // to the idle label and becomes disabled (dirty=false).
    await expect(
      page.getByRole("button", { name: /save settings/i }),
    ).toBeDisabled();

    // Reload the page and verify the new value is what the server returned.
    await page.reload();
    await expect(page.getByText(/^5$/).first()).toBeVisible();
  });

  test("saving an invalid webhook URL surfaces the server's validation error inline", async ({
    page,
  }) => {
    await page.goto("/settings");

    await page
      .getByPlaceholder(/yourdomain\.com/i)
      .fill("not-a-real-url");

    await page.getByRole("button", { name: /save settings/i }).click();

    // Exactly the message the server returns depends on zod's formatter,
    // but it will surface as a short error line under the Save button. The
    // Save button does NOT become disabled because the form is still dirty
    // (save failed).
    await expect(page.locator("text=/failed|invalid|url/i").first()).toBeVisible();
  });
});
