import { test, expect } from "@playwright/test";

// Smoke-level journey: the server process boots, serves the SPA, and the
// setup-wizard redirect fires on a first-run config. Playwright's webServer
// block (see playwright.config.ts) runs `pnpm start` in CI against a scratch
// APPLAUD_CONFIG_DIR, so this exercises the real production build + Express
// route guard + React router, not a mocked app shell.

test.describe("RootScribe smoke journey", () => {
  test("loads the root URL and redirects to the setup wizard on a fresh install", async ({
    page,
  }) => {
    await page.goto("/");

    // The React route guard redirects to /setup/welcome when setup is
    // incomplete. We wait for the final URL rather than asserting on /
    // directly, because the guard fires client-side after the initial SPA
    // shell loads.
    await expect(page).toHaveURL(/\/setup/);
  });

  test("renders the Welcome step with navigable 'Start' control", async ({
    page,
  }) => {
    await page.goto("/setup");

    // The Welcome step is the first wizard page. Any brand text or the Start
    // button serves as a load signal — we assert on the button because it's
    // the exact control a user would click next.
    const startButton = page.getByRole("button", { name: /start|begin|continue|next/i }).first();
    await expect(startButton).toBeVisible({ timeout: 10_000 });
  });

  test("exposes a JSON health check at /api/setup/status", async ({
    request,
  }) => {
    const response = await request.get("/api/setup/status");
    expect(response.ok()).toBe(true);

    const body = await response.json();
    expect(body).toMatchObject({
      setupComplete: false,
      hasToken: false,
      hasRecordingsDir: false,
    });
  });
});
