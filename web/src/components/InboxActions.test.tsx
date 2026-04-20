import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  inboxMutationResponseFactory,
  recordingDetailFactory,
} from "@rootscribe/shared/test-factories";
import { InboxActions } from "./InboxActions.js";
import { jsonResponse, renderWithProviders, stubFetch } from "../test-utils.js";

// Build an InboxMutationResponse whose recording has a specific inboxStatus.
// Used by the mutation tests to stub the server's PATCH response — callers
// only care about the returned `inboxStatus`, so the factory's other
// derivations (reviewedAt, snoozedUntil) are harmless defaults.
function mutationResponseFor(
  inboxStatus: "new" | "reviewed" | "archived",
): ReturnType<typeof inboxMutationResponseFactory.build> {
  return inboxMutationResponseFactory
    .withRecording(recordingDetailFactory.build({ inboxStatus }))
    .build();
}

describe("InboxActions — button surface per effective status", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("on 'new': Mark Reviewed (primary), Snooze, Archive — no Reopen, no Unsnooze", () => {
    renderWithProviders(<InboxActions recording={recordingDetailFactory.build()} />);
    expect(screen.getByRole("button", { name: /mark reviewed/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^snooze$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^archive$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reopen/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unsnooze/i })).not.toBeInTheDocument();
  });

  it("on 'snoozed': Unsnooze (instead of Snooze), no Reopen", () => {
    renderWithProviders(<InboxActions recording={recordingDetailFactory.snoozed().build()} />);
    expect(screen.getByRole("button", { name: /unsnooze/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^snooze$/i })).not.toBeInTheDocument();
  });

  it("on 'reviewed': Reviewed (disabled) + Reopen + Archive (Archive is hidden only on 'archived')", () => {
    // Re-documenting the surface: Archive intentionally stays visible on
    // 'reviewed' so a user can archive an item they already marked reviewed
    // without first reopening it. The only state that hides Archive is
    // 'archived' itself.
    renderWithProviders(<InboxActions recording={recordingDetailFactory.reviewed().build()} />);
    expect(screen.getByRole("button", { name: /^reviewed$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /reopen/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^archive$/i })).toBeInTheDocument();
    // Snooze disappears since the recording isn't in the 'new' state.
    expect(screen.queryByRole("button", { name: /^snooze$/i })).not.toBeInTheDocument();
  });

  it("on 'archived': Reopen but no Archive button (hidden when already archived)", () => {
    renderWithProviders(<InboxActions recording={recordingDetailFactory.archived().build()} />);
    expect(screen.getByRole("button", { name: /reopen/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
  });
});

describe("InboxActions — mutations", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("Mark Reviewed PATCHes /status with { status: 'reviewed' }", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse(mutationResponseFor("reviewed")),
    );
    const user = userEvent.setup();
    renderWithProviders(<InboxActions recording={recordingDetailFactory.build()} />);

    await user.click(screen.getByRole("button", { name: /mark reviewed/i }));
    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = stub.fetch.mock.calls[0]!;
    expect(url).toBe("/api/recordings/rec-1/status");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ status: "reviewed" });
  });

  it("Archive PATCHes /status with { status: 'archived' }", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse(mutationResponseFor("archived")),
    );
    const user = userEvent.setup();
    renderWithProviders(<InboxActions recording={recordingDetailFactory.build()} />);

    await user.click(screen.getByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(stub.fetch.mock.calls[0]![1]?.body))).toEqual({
      status: "archived",
    });
  });

  it("Reopen PATCHes /status with { status: 'new' }", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse(mutationResponseFor("new")),
    );
    const user = userEvent.setup();
    renderWithProviders(<InboxActions recording={recordingDetailFactory.reviewed().build()} />);

    await user.click(screen.getByRole("button", { name: /reopen/i }));
    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(stub.fetch.mock.calls[0]![1]?.body))).toEqual({
      status: "new",
    });
  });

  it("Unsnooze PATCHes /snooze with { snoozedUntil: null }", async () => {
    stub.fetch.mockResolvedValueOnce(jsonResponse(inboxMutationResponseFactory.build()));
    const user = userEvent.setup();
    renderWithProviders(<InboxActions recording={recordingDetailFactory.snoozed().build()} />);

    await user.click(screen.getByRole("button", { name: /unsnooze/i }));
    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = stub.fetch.mock.calls[0]!;
    expect(url).toBe("/api/recordings/rec-1/snooze");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ snoozedUntil: null });
  });

  it("Snooze opens the SnoozeMenu popover on click; picking a preset PATCHes /snooze", async () => {
    stub.fetch.mockResolvedValueOnce(jsonResponse(inboxMutationResponseFactory.build()));
    const user = userEvent.setup();
    renderWithProviders(<InboxActions recording={recordingDetailFactory.build()} />);

    await user.click(screen.getByRole("button", { name: /^snooze$/i }));
    // Popover opened — preset buttons are now available.
    const tomorrow = await screen.findByRole("button", { name: /^tomorrow$/i });
    await user.click(tomorrow);

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(stub.fetch.mock.calls[0]![1]?.body));
    expect(typeof body.snoozedUntil).toBe("number");
    expect(body.snoozedUntil).toBeGreaterThan(Date.now());
  });

  it("surfaces the mutation error message inline when a PATCH fails", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse({ error: "nope" }, { status: 500 }),
    );
    const user = userEvent.setup();
    renderWithProviders(<InboxActions recording={recordingDetailFactory.build()} />);

    await user.click(screen.getByRole("button", { name: /mark reviewed/i }));
    expect(await screen.findByText(/nope/i)).toBeInTheDocument();
  });
});
