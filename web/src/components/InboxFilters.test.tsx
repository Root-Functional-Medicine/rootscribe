import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RecordingsListFilter } from "@rootscribe/shared";
import { InboxFilters } from "./InboxFilters.js";

// InboxFilters is a controlled presentational component — no queries, no
// mutations, no router. Plain React render is enough; no providers needed.

function makeProps(overrides: Partial<React.ComponentProps<typeof InboxFilters>> = {}) {
  return {
    filter: "all" as RecordingsListFilter,
    onFilterChange: vi.fn(),
    category: "",
    onCategoryChange: vi.fn(),
    tag: "",
    onTagChange: vi.fn(),
    availableTags: [],
    availableCategories: [],
    ...overrides,
  };
}

// Stateful wrapper that mirrors how a real parent (e.g. RecordingsList) holds
// the tag/category state. Without this, the component would stay at tag=""
// across keystrokes and we couldn't verify that onChange receives the full
// cumulative string — we'd only see per-keystroke deltas, which would mask a
// regression where the component only propagates the last character.
interface StatefulInputsProps {
  initialTag?: string;
  initialCategory?: string;
  onTagChange?: (tag: string) => void;
  onCategoryChange?: (category: string) => void;
}
function StatefulInputs({
  initialTag = "",
  initialCategory = "",
  onTagChange,
  onCategoryChange,
}: StatefulInputsProps): React.ReactElement {
  const [tag, setTag] = useState(initialTag);
  const [category, setCategory] = useState(initialCategory);
  return (
    <InboxFilters
      {...makeProps({
        tag,
        category,
        onTagChange: (next) => {
          setTag(next);
          onTagChange?.(next);
        },
        onCategoryChange: (next) => {
          setCategory(next);
          onCategoryChange?.(next);
        },
      })}
    />
  );
}

describe("InboxFilters — filter tabs", () => {
  it("renders all five status-filter buttons with their labels", () => {
    render(<InboxFilters {...makeProps()} />);
    for (const label of ["All", "Active", "Reviewed", "Snoozed", "Archived"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the active tab with aria-pressed=true and inactive tabs with aria-pressed=false", () => {
    render(<InboxFilters {...makeProps({ filter: "reviewed" })} />);
    expect(screen.getByRole("button", { name: "Reviewed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("highlights the Active tab for both filter='active' and filter='new' (deep-link alias)", () => {
    const { rerender } = render(<InboxFilters {...makeProps({ filter: "active" })} />);
    expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    rerender(<InboxFilters {...makeProps({ filter: "new" })} />);
    expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("calls onFilterChange with the tab's value when a tab is clicked", async () => {
    const onFilterChange = vi.fn();
    const user = userEvent.setup();
    render(
      <InboxFilters {...makeProps({ filter: "all", onFilterChange })} />,
    );

    await user.click(screen.getByRole("button", { name: "Snoozed" }));
    expect(onFilterChange).toHaveBeenCalledWith("snoozed");
  });
});

describe("InboxFilters — tag + category inputs", () => {
  it("propagates the cumulative tag value to onTagChange as the user types", async () => {
    const onTagChange = vi.fn();
    const user = userEvent.setup();
    // StatefulInputs mirrors the real parent's useState — onTagChange should
    // see "f" then "fu" (cumulative), not just "f" then "u" (per-keystroke
    // deltas). This catches a regression where the component only propagates
    // the last character.
    render(<StatefulInputs onTagChange={onTagChange} />);

    // Inputs are implicitly labeled by their wrapping <label> containing
    // a <span>Tag</span> — Testing Library picks that up.
    await user.type(screen.getByLabelText(/tag/i), "fu");
    expect(onTagChange).toHaveBeenNthCalledWith(1, "f");
    expect(onTagChange).toHaveBeenNthCalledWith(2, "fu");
    expect(onTagChange).toHaveBeenLastCalledWith("fu");
  });

  it("propagates the cumulative category value to onCategoryChange as the user types", async () => {
    const onCategoryChange = vi.fn();
    const user = userEvent.setup();
    render(<StatefulInputs onCategoryChange={onCategoryChange} />);

    await user.type(screen.getByLabelText(/category/i), "bi");
    expect(onCategoryChange).toHaveBeenNthCalledWith(1, "b");
    expect(onCategoryChange).toHaveBeenNthCalledWith(2, "bi");
    expect(onCategoryChange).toHaveBeenLastCalledWith("bi");
  });

  it("shows a 'clear' button next to the tag input only when tag is non-empty", () => {
    const { rerender } = render(<InboxFilters {...makeProps({ tag: "" })} />);
    expect(screen.queryByText("clear")).not.toBeInTheDocument();

    rerender(<InboxFilters {...makeProps({ tag: "urgent" })} />);
    expect(screen.getByText("clear")).toBeInTheDocument();
  });

  it("clicking the tag clear button emits onTagChange('')", async () => {
    const onTagChange = vi.fn();
    const user = userEvent.setup();
    render(<InboxFilters {...makeProps({ tag: "urgent", onTagChange })} />);
    // Category is empty so there's exactly one clear button.
    await user.click(screen.getByText("clear"));
    expect(onTagChange).toHaveBeenCalledWith("");
  });

  it("renders availableTags and availableCategories into their respective datalists", () => {
    const { container } = render(
      <InboxFilters
        {...makeProps({
          availableTags: ["t1", "t2"],
          availableCategories: ["c1"],
        })}
      />,
    );
    // Datalist options have no accessibility role in happy-dom. Scope the
    // query by the datalist id so we're asserting the wire-up, not bulk
    // matching across two lists.
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const tagOpts = container.querySelectorAll<HTMLOptionElement>(
      "#inbox-tags-list option",
    );
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const catOpts = container.querySelectorAll<HTMLOptionElement>(
      "#inbox-categories-list option",
    );
    expect(Array.from(tagOpts).map((o) => o.value)).toEqual(["t1", "t2"]);
    expect(Array.from(catOpts).map((o) => o.value)).toEqual(["c1"]);
  });
});
