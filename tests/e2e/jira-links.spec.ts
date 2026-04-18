import { test, expect } from "@playwright/test";

// Journey: Jira link add + unlink. Exercises the JiraLinksEditor on the
// RecordingDetail page. Fixture state:
//   - rec-reviewed-linked has ROOT-101 pre-linked (unlink target)
//   - rec-reviewed-unlinked has no links (add target)

test.beforeEach(async ({ request }) => {
  // Assert the reset actually succeeded — a 404 here means /api/_test/* is
  // not mounted (e.g. Playwright reused a non-E2E server), in which case
  // the test would otherwise run against whatever state is on disk and
  // could mutate a developer's real config/DB.
  const response = await request.post("/api/_test/reset");
  expect(response.ok()).toBeTruthy();
  await expect(response.json()).resolves.toEqual({ ok: true });
});

test.describe("Jira link/unlink", () => {
  test("pre-existing ROOT-101 link is rendered as an anchor to the configured base URL", async ({
    page,
  }) => {
    await page.goto("/recordings/rec-reviewed-linked");

    const link = page.getByRole("link", { name: /ROOT-101/i });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      "href",
      /https:\/\/example\.atlassian\.net\/browse\/ROOT-101/,
    );
  });

  test("clicking the unlink button removes the link from the list", async ({
    page,
  }) => {
    await page.goto("/recordings/rec-reviewed-linked");

    await page.getByRole("button", { name: /unlink ROOT-101/i }).click();

    // Either the link disappears or the empty-state copy takes its place.
    await expect(page.getByRole("link", { name: /ROOT-101/i })).toHaveCount(0);
    await expect(page.getByText(/no linked issues/i)).toBeVisible();
  });

  test("typing an issue key into rec-reviewed-unlinked and submitting creates the link", async ({
    page,
  }) => {
    await page.goto("/recordings/rec-reviewed-unlinked");

    // Start state: no links on this recording.
    await expect(page.getByText(/no linked issues/i)).toBeVisible();

    await page.getByPlaceholder("ISSUE-123").fill("ROOT-202");
    await page.getByRole("button", { name: /^link issue$/i }).click();

    // After the mutation lands, the link appears as a rendered anchor.
    const link = page.getByRole("link", { name: /ROOT-202/i });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      "href",
      /https:\/\/example\.atlassian\.net\/browse\/ROOT-202/,
    );
  });

  test("the Link issue button stays disabled until the key is valid", async ({
    page,
  }) => {
    await page.goto("/recordings/rec-reviewed-unlinked");

    const submit = page.getByRole("button", { name: /invalid key|link issue/i });
    await expect(submit).toBeDisabled();

    await page.getByPlaceholder("ISSUE-123").fill("not a key");

    // Invalid-key state swaps the button label AND keeps it disabled.
    await expect(page.getByRole("button", { name: /invalid key/i })).toBeDisabled();
  });
});
