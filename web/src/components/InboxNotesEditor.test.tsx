import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InboxNotesEditor } from "./InboxNotesEditor.js";
import {
  jsonResponse,
  makeInboxMutationResponse as mutationResponse,
  renderWithProviders,
  stubFetch,
} from "../test-utils.js";

describe("InboxNotesEditor", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
  });

  afterEach(() => {
    stub.cleanup();
  });

  it("initializes the textarea with the current notes value", () => {
    renderWithProviders(<InboxNotesEditor recordingId="rec-1" notes="existing text" />);
    expect(screen.getByRole("textbox")).toHaveValue("existing text");
  });

  it("initializes to an empty string when notes is null", () => {
    renderWithProviders(<InboxNotesEditor recordingId="rec-1" notes={null} />);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("commits the new value to PATCH /api/recordings/:id/notes on blur", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse(mutationResponse({ inboxNotes: "new content" })),
    );
    const user = userEvent.setup();

    renderWithProviders(<InboxNotesEditor recordingId="rec-1" notes={null} />);
    const box = screen.getByRole("textbox");
    await user.type(box, "new content");
    await user.tab(); // blur

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = stub.fetch.mock.calls[0]!;
    expect(url).toBe("/api/recordings/rec-1/notes");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ notes: "new content" });
  });

  it("preserves whitespace-only input by sending null instead of the spaces", async () => {
    stub.fetch.mockResolvedValueOnce(jsonResponse(mutationResponse()));
    const user = userEvent.setup();

    renderWithProviders(<InboxNotesEditor recordingId="rec-1" notes="prior" />);
    const box = screen.getByRole("textbox");
    await user.clear(box);
    await user.type(box, "   ");
    await user.tab();

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(stub.fetch.mock.calls[0]![1]?.body))).toEqual({ notes: null });
  });

  it("does not call the API when the committed value equals the current notes (no-op)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<InboxNotesEditor recordingId="rec-1" notes="same" />);
    const box = screen.getByRole("textbox");
    await user.click(box);
    await user.tab();
    // No fetch was dispatched since draft==="same"===current.
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("syncs the draft back to the prop when notes changes from outside (different recording selected)", () => {
    const { rerender } = renderWithProviders(
      <InboxNotesEditor recordingId="rec-1" notes="first" />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("first");
    rerender(<InboxNotesEditor recordingId="rec-2" notes="second" />);
    expect(screen.getByRole("textbox")).toHaveValue("second");
  });
});
