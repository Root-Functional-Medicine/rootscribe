import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeContext, type Theme } from "../hooks/useTheme.js";
import { ThemeToggle } from "./ThemeToggle.js";

// ThemeToggle consumes ThemeContext directly — we wrap it in a minimal
// Provider whose toggle is a spy so we can assert the button is wired up.
// No other providers are needed here; the component has no queries, router,
// or side effects.

function renderWithTheme(theme: Theme, toggle = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <ThemeContext.Provider
      value={{ theme, setTheme: () => undefined, toggle }}
    >
      <ThemeToggle />
    </ThemeContext.Provider>,
  );
  return toggle;
}

describe("ThemeToggle", () => {
  it("renders the moon (switch-to-dark) icon when the current theme is light", () => {
    renderWithTheme("light");
    // The button's accessible label documents where it will move next,
    // which matches the icon we render. Pinning the label IS pinning the
    // rendered icon — avoids asserting on raw SVG paths.
    expect(
      screen.getByRole("button", { name: /switch to dark mode/i }),
    ).toBeInTheDocument();
  });

  it("renders the sun (switch-to-light) icon when the current theme is dark", () => {
    renderWithTheme("dark");
    expect(
      screen.getByRole("button", { name: /switch to light mode/i }),
    ).toBeInTheDocument();
  });

  it("calls toggle() once per click", async () => {
    const toggle = renderWithTheme("light");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button"));
    expect(toggle).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button"));
    expect(toggle).toHaveBeenCalledTimes(2);
  });
});
