import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TagEditor } from "./TagEditor.js";
import {
  jsonResponse,
  makeInboxMutationResponse as mutationResponse,
  renderWithProviders,
  stubFetch,
} from "../test-utils.js";

describe("TagEditor — rendering", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("shows 'No tags' placeholder when the tag list is empty", () => {
    renderWithProviders(
      <TagEditor recordingId="rec-1" tags={[]} availableTags={[]} />,
    );
    expect(screen.getByText(/no tags/i)).toBeInTheDocument();
  });

  it("renders a chip + accessible remove button for each existing tag", () => {
    renderWithProviders(
      <TagEditor recordingId="rec-1" tags={["followup", "urgent"]} availableTags={[]} />,
    );
    expect(screen.getByText("followup")).toBeInTheDocument();
    expect(screen.getByText("urgent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove tag followup/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove tag urgent/i })).toBeInTheDocument();
  });

  it("populates the datalist with availableTags for typeahead", () => {
    const { container } = renderWithProviders(
      <TagEditor
        recordingId="rec-1"
        tags={[]}
        availableTags={["alpha", "beta"]}
      />,
    );
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const options = container.querySelectorAll<HTMLOptionElement>("datalist option");
    expect(Array.from(options).map((o) => o.value)).toEqual(["alpha", "beta"]);
  });

  it("disables the Add button when the draft is empty or whitespace-only", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <TagEditor recordingId="rec-1" tags={[]} availableTags={[]} />,
    );
    const button = screen.getByRole("button", { name: /add/i });
    expect(button).toBeDisabled();

    const input = screen.getByPlaceholderText(/add tag/i);
    await user.type(input, "   ");
    expect(button).toBeDisabled();

    await user.type(input, "x");
    expect(button).not.toBeDisabled();
  });
});

describe("TagEditor — adding tags", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("adds a new tag via the button: POST with { tag } body + draft cleared on success", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse(mutationResponse({ tags: ["ops"] })),
    );
    const user = userEvent.setup();

    renderWithProviders(<TagEditor recordingId="rec-1" tags={[]} availableTags={[]} />);
    const input = screen.getByPlaceholderText(/add tag/i);
    await user.type(input, "ops");
    await user.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = stub.fetch.mock.calls[0]!;
    expect(url).toBe("/api/recordings/rec-1/tags");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ tag: "ops" });

    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("submits on Enter as well as on button click", async () => {
    stub.fetch.mockResolvedValueOnce(jsonResponse(mutationResponse()));
    const user = userEvent.setup();

    renderWithProviders(<TagEditor recordingId="rec-1" tags={[]} availableTags={[]} />);
    await user.type(screen.getByPlaceholderText(/add tag/i), "kb{Enter}");

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
  });

  it("trims the draft before submitting (leading/trailing spaces dropped)", async () => {
    stub.fetch.mockResolvedValueOnce(jsonResponse(mutationResponse()));
    const user = userEvent.setup();

    renderWithProviders(<TagEditor recordingId="rec-1" tags={[]} availableTags={[]} />);
    await user.type(screen.getByPlaceholderText(/add tag/i), "  spaced  {Enter}");

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(stub.fetch.mock.calls[0]![1]?.body))).toEqual({
      tag: "spaced",
    });
  });

  it("skips the API call when the typed tag already exists (no duplicate POST) and clears the draft", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <TagEditor recordingId="rec-1" tags={["already"]} availableTags={[]} />,
    );

    const input = screen.getByPlaceholderText(/add tag/i);
    await user.type(input, "already{Enter}");

    expect(stub.fetch).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });

  it("preserves the draft on failure so the user can retry without retyping", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse({ error: "server broke" }, { status: 500 }),
    );
    const user = userEvent.setup();

    renderWithProviders(<TagEditor recordingId="rec-1" tags={[]} availableTags={[]} />);
    const input = screen.getByPlaceholderText(/add tag/i);
    await user.type(input, "retryable{Enter}");

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    // Error message surfaced, draft intact.
    expect(await screen.findByText(/couldn't add tag/i)).toBeInTheDocument();
    expect(input).toHaveValue("retryable");
  });
});

describe("TagEditor — removing tags", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("DELETEs /tags/<tag> with URL-encoded tag when the × button is clicked", async () => {
    stub.fetch.mockResolvedValueOnce(jsonResponse(mutationResponse()));
    const user = userEvent.setup();

    renderWithProviders(
      <TagEditor
        recordingId="rec-1"
        tags={["has space"]}
        availableTags={[]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /remove tag has space/i }));

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = stub.fetch.mock.calls[0]!;
    expect(url).toBe("/api/recordings/rec-1/tags/has%20space");
    expect(init?.method).toBe("DELETE");
  });
});
