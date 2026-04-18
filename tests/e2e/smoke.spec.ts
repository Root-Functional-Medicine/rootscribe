import { test, expect } from "@playwright/test";

// Smoke-level checks against the seeded config populated by global-setup.ts.
// Every other journey spec assumes the same fixtures (12 recordings, a
// pre-linked ROOT-101, etc.); this file is the canary that catches broken
// boot / routing / static-asset plumbing before those richer assertions run.

test.describe("RootScribe smoke (seeded)", () => {
  test("GET / renders the dashboard directly — setupComplete is true in the fixture", async ({
    page,
  }) => {
    await page.goto("/");

    // The route guard that redirects to /setup fires only when setupComplete
    // is false. Against a seeded (completed) config, the SPA should render
    // the Dashboard route directly.
    await expect(page).not.toHaveURL(/\/setup/);
    await expect(
      page.getByRole("heading", { level: 1, name: /recordings/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("/api/setup/status reflects the seeded fixture (all three flags true)", async ({
    request,
  }) => {
    const response = await request.get("/api/setup/status");
    expect(response.ok()).toBe(true);

    const body = await response.json();
    expect(body).toMatchObject({
      setupComplete: true,
      hasToken: true,
      hasRecordingsDir: true,
    });
  });

  test("the /api/_test/reset gate is mounted under ROOTSCRIBE_E2E=1", async ({
    request,
  }) => {
    // Belt-and-suspenders: the production-safety assertion in
    // server/tests/routes/_test.test.ts reads the source to verify the gate;
    // this one proves the server ACTUALLY exposes the route under the flag
    // we're exercising in E2E. A regression that neuters the flag would
    // fail the server tests AND this one.
    const response = await request.post("/api/_test/reset");
    expect(response.ok()).toBe(true);
  });
});
