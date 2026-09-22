import { test, expect } from "@playwright/test";

// Journey: Settings page — poll interval update, webhook URL update, Jira
// base URL update, webhook signing secret + instance id. The seeded config
// has pollIntervalMinutes=10, empty webhook,
// jiraBaseUrl=https://example.atlassian.net/browse/, and
// instanceId=e2e-seed-instance.

test.beforeEach(async ({ request }) => {
  // Assert the reset actually succeeded — a 404 here means /api/_test/* is
  // not mounted (e.g. Playwright reused a non-E2E server), in which case
  // the test would otherwise run against whatever state is on disk and
  // could mutate a developer's real config/DB.
  const response = await request.post("/api/_test/reset");
  expect(response.ok()).toBeTruthy();
  await expect(response.json()).resolves.toEqual({ ok: true });
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

  test("renders the seeded instance id in the Webhook section", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByLabel(/instance id/i)).toHaveValue("e2e-seed-instance");
  });

  test("saving a generated signing secret and an edited instance id persists both (secret never echoed back)", async ({
    page,
    request,
  }) => {
    await page.goto("/settings");

    // The secret only rides inside the webhook object, so a URL is required
    // for it to be persisted at all.
    await page.getByPlaceholder(/yourdomain\.com/i).fill("https://hook.example/ingest");

    await page.getByRole("button", { name: /generate/i }).click();
    const secretInput = page.getByLabel(/signing secret/i);
    await expect(secretInput).toHaveValue(/^[0-9a-f]{64}$/);

    const instanceInput = page.getByLabel(/instance id/i);
    await instanceInput.fill("e2e-edited-instance");

    await page.getByRole("button", { name: /save settings/i }).click();
    await expect(page.getByRole("button", { name: /save settings/i })).toBeDisabled();

    // After reload the instance id is read back; the secret is NOT (the API
    // redacts it) — the field is empty and reports the configured state.
    await page.reload();
    await expect(page.getByLabel(/instance id/i)).toHaveValue("e2e-edited-instance");
    await expect(page.getByLabel(/signing secret/i)).toHaveValue("");
    await expect(page.getByLabel(/signing secret/i)).toHaveAttribute("placeholder", /configured/i);
    await expect(page.getByRole("button", { name: /^clear$/i })).toBeVisible();

    // GET /api/config is a straight read of settings.json through
    // loadConfig(): instance id stored, secret stored but never returned.
    const cfg = (await (await request.get("/api/config")).json()) as {
      config: {
        webhook: { url: string; secret?: string; secretConfigured?: boolean } | null;
        instanceId: string | null;
      };
    };
    expect(cfg.config.webhook?.url).toBe("https://hook.example/ingest");
    expect(cfg.config.webhook?.secretConfigured).toBe(true);
    expect(cfg.config.webhook).not.toHaveProperty("secret");
    expect(cfg.config.instanceId).toBe("e2e-edited-instance");

    // An unrelated save with the secret field untouched keeps the stored
    // secret (tri-state: omitted = keep).
    await page.getByLabel(/instance id/i).fill("e2e-edited-again");
    await page.getByRole("button", { name: /save settings/i }).click();
    await expect(page.getByRole("button", { name: /save settings/i })).toBeDisabled();
    const after = (await (await request.get("/api/config")).json()) as {
      config: { webhook: { secretConfigured?: boolean } | null; instanceId: string | null };
    };
    expect(after.config.webhook?.secretConfigured).toBe(true);
    expect(after.config.instanceId).toBe("e2e-edited-again");
  });
});
