import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { SnoozeMenu } from "./SnoozeMenu.js";

// Anchor Date.now() for predictable "tomorrow" math.
const FROZEN_NOW = Date.UTC(2026, 3, 15, 12, 0, 0); // 2026-04-15T12:00:00Z

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FROZEN_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SnoozeMenu — presets", () => {
  it("renders Tomorrow / In 3 days / Next week presets plus a custom option", () => {
    render(<SnoozeMenu onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^tomorrow$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /in 3 days/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next week/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pick a date/i })).toBeInTheDocument();
  });

  it("picking 'Tomorrow' fires onSelect with Date.now() + 24h and onClose", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<SnoozeMenu onSelect={onSelect} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /^tomorrow$/i }));

    const DAY = 24 * 60 * 60 * 1000;
    expect(onSelect).toHaveBeenCalledWith(FROZEN_NOW + DAY);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("picking 'Next week' fires onSelect with Date.now() + 7*24h", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnoozeMenu onSelect={onSelect} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /next week/i }));
    const DAY = 24 * 60 * 60 * 1000;
    expect(onSelect).toHaveBeenCalledWith(FROZEN_NOW + 7 * DAY);
  });
});

describe("SnoozeMenu — custom date mode", () => {
  it("shows the date picker + Back/Snooze buttons after clicking 'Pick a date…'", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnoozeMenu onSelect={vi.fn()} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /pick a date/i }));
    expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^snooze$/i })).toBeInTheDocument();
  });

  it("Back returns to preset mode without calling onSelect", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnoozeMenu onSelect={onSelect} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /pick a date/i }));
    await user.click(screen.getByRole("button", { name: /back/i }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^tomorrow$/i })).toBeInTheDocument();
  });

  it("clicking Snooze with the default date fires onSelect with end-of-day (23:59:59.999)", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnoozeMenu onSelect={onSelect} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /pick a date/i }));
    await user.click(screen.getByRole("button", { name: /^snooze$/i }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    const picked = new Date(onSelect.mock.calls[0]![0]);
    // End of the local "tomorrow" — 23:59:59 to avoid the "snooze pops at
    // midnight" footgun.
    expect(picked.getHours()).toBe(23);
    expect(picked.getMinutes()).toBe(59);
    expect(picked.getSeconds()).toBe(59);
  });
});

describe("SnoozeMenu — dismiss behaviors", () => {
  it("pressing Escape anywhere on the document fires onClose", () => {
    const onClose = vi.fn();
    render(<SnoozeMenu onSelect={vi.fn()} onClose={onClose} />);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("mousedown outside the menu (and outside the anchor) fires onClose", () => {
    const onClose = vi.fn();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      render(<SnoozeMenu onSelect={vi.fn()} onClose={onClose} />);
      outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeChild(outside);
    }
  });

  it("mousedown on the anchor element is ignored (anchor's own click handles the toggle)", () => {
    const onClose = vi.fn();
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const anchorRef = createRef<HTMLElement>();
    Object.defineProperty(anchorRef, "current", { value: anchor, writable: true });
    try {
      render(<SnoozeMenu onSelect={vi.fn()} onClose={onClose} anchorRef={anchorRef} />);
      anchor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(anchor);
    }
  });
});
