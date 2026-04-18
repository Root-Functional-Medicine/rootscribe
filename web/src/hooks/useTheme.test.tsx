import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useThemeProvider } from "./useTheme.js";

// useThemeProvider owns real browser state (localStorage + documentElement
// classList + matchMedia). Test it in isolation via renderHook — no provider
// wrapping needed since useThemeProvider is the hook the PROVIDER calls, not
// a consumer hook that expects context.

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

function stubMatchMedia(prefersDark: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: prefersDark,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  );
}

describe("useThemeProvider — initial theme resolution", () => {
  it("uses the saved localStorage value when present", () => {
    localStorage.setItem("rootscribe-theme", "dark");
    stubMatchMedia(false);
    const { result } = renderHook(() => useThemeProvider());
    expect(result.current.theme).toBe("dark");
  });

  it("falls back to system preference when nothing is saved (prefers-dark → dark)", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useThemeProvider());
    expect(result.current.theme).toBe("dark");
  });

  it("falls back to light when system preference is not dark and nothing is saved", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useThemeProvider());
    expect(result.current.theme).toBe("light");
  });

  it("ignores unknown/corrupt localStorage values and falls through to system preference", () => {
    // Guards against "theme=garbage" in storage from an older version or
    // manual devtools edit — without the strict union check, setTheme(null!)
    // could leak into the state.
    localStorage.setItem("rootscribe-theme", "not-a-real-theme");
    stubMatchMedia(true);
    const { result } = renderHook(() => useThemeProvider());
    expect(result.current.theme).toBe("dark");
  });
});

describe("useThemeProvider — DOM + storage side effects", () => {
  it("adds the 'dark' class to <html> when dark is active and removes it when light", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useThemeProvider());
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    act(() => result.current.setTheme("dark"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    act(() => result.current.setTheme("light"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("persists every change to localStorage under rootscribe-theme", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useThemeProvider());
    expect(localStorage.getItem("rootscribe-theme")).toBe("light");

    act(() => result.current.setTheme("dark"));
    expect(localStorage.getItem("rootscribe-theme")).toBe("dark");
  });
});

describe("useThemeProvider — toggle()", () => {
  it("flips dark → light", () => {
    localStorage.setItem("rootscribe-theme", "dark");
    stubMatchMedia(false);
    const { result } = renderHook(() => useThemeProvider());
    act(() => result.current.toggle());
    expect(result.current.theme).toBe("light");
  });

  it("flips light → dark", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useThemeProvider());
    act(() => result.current.toggle());
    expect(result.current.theme).toBe("dark");
  });
});
