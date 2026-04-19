import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecordingsDirStep } from "./RecordingsDirStep.js";
import { jsonResponse, renderWithProviders, stubFetch } from "../../test-utils.js";

// RecordingsDirStep composes two actions: validate (dry run) + save (mutation).
// Both go through the real jsonFetch pipeline via a stubbed global.fetch —
// no mock-heavy internals.

function routeDirFetch(
  stub: ReturnType<typeof stubFetch>,
  opts: {
    validate?:
      | { ok: boolean; absolutePath?: string; freeBytes?: number; error?: string }
      | "pending"
      | "throw";
    save?: "ok" | "throw";
  } = {},
): void {
  stub.fetch.mockImplementation((input) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/config/validate-recordings-dir")) {
      if (opts.validate === "pending") return new Promise(() => undefined);
      if (opts.validate === "throw") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "nope" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(opts.validate ?? { ok: true, absolutePath: "/abs/recordings" }),
      );
    }
    if (url === "/api/config") {
      if (opts.save === "throw") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "write failed" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(jsonResponse({ config: {} }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

describe("RecordingsDirStep — validation", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("renders with the default ./recordings path pre-filled", () => {
    routeDirFetch(stub);
    renderWithProviders(
      <RecordingsDirStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByPlaceholderText(/\/Users\/you\/Plaud/i)).toHaveValue(
      "./recordings",
    );
  });

  it("Next button is disabled until validation returns ok=true", async () => {
    routeDirFetch(stub);
    renderWithProviders(
      <RecordingsDirStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
  });

  it("clicking Check posts to validate-recordings-dir and renders the success state on ok", async () => {
    const user = userEvent.setup();
    routeDirFetch(stub, {
      validate: {
        ok: true,
        absolutePath: "/Users/alice/Plaud",
        freeBytes: 50 * 1024 ** 3,
      },
    });
    renderWithProviders(
      <RecordingsDirStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /^check$/i }));
    expect(await screen.findByText(/directory valid/i)).toBeInTheDocument();
    expect(
      screen.getByText(/\/Users\/alice\/Plaud — 50\.0 GB free/i),
    ).toBeInTheDocument();
    // Next is now enabled.
    expect(screen.getByRole("button", { name: /^next$/i })).not.toBeDisabled();
  });

  it("renders the error banner when validation returns ok=false", async () => {
    const user = userEvent.setup();
    routeDirFetch(stub, {
      validate: { ok: false, error: "not writable" },
    });
    renderWithProviders(
      <RecordingsDirStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /^check$/i }));
    expect(await screen.findByText(/directory invalid/i)).toBeInTheDocument();
    expect(screen.getByText(/not writable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
  });

  it("surfaces a network error as an invalid-directory result", async () => {
    const user = userEvent.setup();
    routeDirFetch(stub, { validate: "throw" });
    renderWithProviders(
      <RecordingsDirStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /^check$/i }));
    // ApiError message extracted from the JSON body → "nope".
    expect(await screen.findByText(/nope/)).toBeInTheDocument();
  });

  it("editing the input after validation clears the prior result (forces a re-check)", async () => {
    const user = userEvent.setup();
    routeDirFetch(stub, {
      validate: { ok: true, absolutePath: "/ok" },
    });
    renderWithProviders(
      <RecordingsDirStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /^check$/i }));
    await screen.findByText(/directory valid/i);

    // Type anything → result clears + Next disables again.
    await user.type(
      screen.getByPlaceholderText(/\/Users\/you\/Plaud/i),
      "x",
    );
    expect(screen.queryByText(/directory valid/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
  });
});

describe("RecordingsDirStep — save + navigation", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("clicking Next saves the ABSOLUTE path (not the raw input) via updateConfig", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeDirFetch(stub, {
      validate: { ok: true, absolutePath: "/absolute/expanded/recordings" },
    });
    renderWithProviders(
      <RecordingsDirStep onNext={onNext} onBack={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /^check$/i }));
    await screen.findByText(/directory valid/i);
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => {
      const post = stub.fetch.mock.calls.find(
        ([i, init]) =>
          String(i) === "/api/config" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post?.[1] as RequestInit).body)) as {
        recordingsDir: string;
      };
      expect(body.recordingsDir).toBe("/absolute/expanded/recordings");
    });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("clicking Back calls onBack", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    routeDirFetch(stub);
    renderWithProviders(
      <RecordingsDirStep onNext={vi.fn()} onBack={onBack} />,
    );
    await user.click(screen.getByRole("button", { name: /^back$/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
