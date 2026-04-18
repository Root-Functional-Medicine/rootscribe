import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { InboxStatusPill } from "./InboxStatusPill.js";

describe("InboxStatusPill", () => {
  it("renders a 'NEW' label with primary-color styling for new recordings", () => {
    render(<InboxStatusPill status="new" />);
    const pill = screen.getByText("NEW");
    expect(pill).toBeInTheDocument();
    // The pill element itself carries the text-color class
    expect(pill).toHaveClass("text-primary");
  });

  it("renders a 'REVIEWED' label with secondary styling for reviewed recordings", () => {
    render(<InboxStatusPill status="reviewed" />);
    expect(screen.getByText("REVIEWED")).toHaveClass("text-secondary");
  });

  it("renders a 'SNOOZED' label with tertiary styling for snoozed recordings", () => {
    render(<InboxStatusPill status="snoozed" />);
    expect(screen.getByText("SNOOZED")).toHaveClass("text-tertiary");
  });

  it("renders an 'ARCHIVED' label with muted styling for archived recordings", () => {
    render(<InboxStatusPill status="archived" />);
    expect(screen.getByText("ARCHIVED")).toHaveClass("text-on-surface-variant");
  });

  it("uses larger padding at the default size and tighter padding at size='sm'", () => {
    const { rerender } = render(<InboxStatusPill status="new" />);
    expect(screen.getByText("NEW")).toHaveClass("px-2.5");

    rerender(<InboxStatusPill status="new" size="sm" />);
    expect(screen.getByText("NEW")).toHaveClass("px-2");
  });
});
