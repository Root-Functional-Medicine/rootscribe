import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WelcomeStep } from "./WelcomeStep.js";

// WelcomeStep is a stateless intro slide — no queries, no mutations, no
// router. Plain render is enough; no providers needed.

describe("WelcomeStep", () => {
  it("renders the heading + every bullet describing what the wizard will do", () => {
    render(<WelcomeStep onNext={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: /welcome to rootscribe/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/find your plaud login automatically/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/pick a folder on disk/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/webhook for automations/i)).toBeInTheDocument();
    expect(
      screen.getByText(/polls for new recordings every 10 minutes/i),
    ).toBeInTheDocument();
  });

  it("calls onNext when the Start button is clicked", async () => {
    const onNext = vi.fn();
    const user = userEvent.setup();
    render(<WelcomeStep onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: /start/i }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("does not render a Back button (Welcome is the first step)", () => {
    render(<WelcomeStep onNext={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: /back/i }),
    ).not.toBeInTheDocument();
  });
});
