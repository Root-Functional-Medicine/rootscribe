/* eslint-disable testing-library/no-container, testing-library/no-node-access --
 *
 * Waveform is an SVG path + gradient component. Testing Library's role-
 * based queries can't reach <path>/<stop>/<linearGradient> — SVG elements
 * don't expose meaningful implicit roles in jsdom/happy-dom. Asserting on
 * the rendered SVG structure (the only observable output of this
 * component) requires container.querySelector, which the plugin otherwise
 * rejects. Scope this exception to just this file.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Waveform } from "./Waveform.js";

// Waveform is pure presentation + a click-to-seek handler. No queries, no
// router, no theme. Plain render works.

describe("Waveform — deterministic rendering", () => {
  it("emits an <svg> containing a <path> with a non-empty 'd' attribute", () => {
    const { container } = render(
      <Waveform recordingId="rec-abc" progress={0} onSeek={vi.fn()} />,
    );
    const path = container.querySelector("path");
    expect(path).not.toBeNull();
    expect(path?.getAttribute("d")).toBeTruthy();
  });

  it("produces the same path for the same recordingId (deterministic PRNG)", () => {
    const first = render(
      <Waveform recordingId="seed-pin" progress={0.5} onSeek={vi.fn()} />,
    ).container.querySelector("path")?.getAttribute("d");
    const second = render(
      <Waveform recordingId="seed-pin" progress={0.9} onSeek={vi.fn()} />,
    ).container.querySelector("path")?.getAttribute("d");
    // Paths are independent of progress (progress only drives the gradient).
    expect(first).toBe(second);
  });

  it("produces different paths for different recording ids", () => {
    const a = render(
      <Waveform recordingId="seed-a" progress={0} onSeek={vi.fn()} />,
    ).container.querySelector("path")?.getAttribute("d");
    const b = render(
      <Waveform recordingId="seed-b" progress={0} onSeek={vi.fn()} />,
    ).container.querySelector("path")?.getAttribute("d");
    expect(a).not.toBe(b);
  });

  it("generates a unique gradient id derived from the first 8 chars of recordingId", () => {
    const { container } = render(
      <Waveform recordingId="abcdef1234567890" progress={0} onSeek={vi.fn()} />,
    );
    const grad = container.querySelector("linearGradient");
    expect(grad?.id).toBe("wf-grad-abcdef12");
  });
});

describe("Waveform — progress gradient stops", () => {
  it("updates stop offsets when progress changes (direct DOM mutation, no re-render of path)", () => {
    const { container, rerender } = render(
      <Waveform recordingId="rec-1" progress={0} onSeek={vi.fn()} />,
    );
    const stops = container.querySelectorAll("stop");
    // At progress=0: the primary-color "center" stop should be at 0%.
    expect(stops[3]?.getAttribute("offset")).toBe("0%");

    rerender(<Waveform recordingId="rec-1" progress={0.5} onSeek={vi.fn()} />);
    expect(stops[3]?.getAttribute("offset")).toBe("50%");

    rerender(<Waveform recordingId="rec-1" progress={1} onSeek={vi.fn()} />);
    expect(stops[3]?.getAttribute("offset")).toBe("100%");
  });

  it("clamps out-of-range progress values into [0, 1]", () => {
    const { container, rerender } = render(
      <Waveform recordingId="rec-1" progress={-1} onSeek={vi.fn()} />,
    );
    const stops = container.querySelectorAll("stop");
    expect(stops[3]?.getAttribute("offset")).toBe("0%");

    rerender(<Waveform recordingId="rec-1" progress={2} onSeek={vi.fn()} />);
    expect(stops[3]?.getAttribute("offset")).toBe("100%");
  });
});

describe("Waveform — click-to-seek", () => {
  it("clicking the SVG fires onSeek with a [0, 1] fraction derived from the click x position", async () => {
    const onSeek = vi.fn();
    const { container } = render(
      <Waveform recordingId="rec-1" progress={0} onSeek={onSeek} />,
    );
    const svg = container.querySelector("svg")!;

    // jsdom doesn't compute real layout, so getBoundingClientRect returns
    // zeros — we patch the rect to drive the fraction math deterministically.
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 120, width: 100, height: 120, x: 0, y: 0 }) as DOMRect;

    const user = userEvent.setup();
    // userEvent.click passes a MouseEvent whose clientX lands at the element's
    // center by default. With width=100, that's clientX=50 → fraction=0.5.
    await user.click(svg);

    expect(onSeek).toHaveBeenCalledTimes(1);
    const fraction = onSeek.mock.calls[0]![0];
    expect(fraction).toBeGreaterThanOrEqual(0);
    expect(fraction).toBeLessThanOrEqual(1);
  });

  it("clamps a click past the right edge to 1", async () => {
    const onSeek = vi.fn();
    const { container } = render(
      <Waveform recordingId="rec-1" progress={0} onSeek={onSeek} />,
    );
    const svg = container.querySelector("svg")!;
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 120, width: 100, height: 120, x: 0, y: 0 }) as DOMRect;

    // Dispatch a raw MouseEvent with clientX past the width.
    svg.dispatchEvent(new MouseEvent("click", { clientX: 500, clientY: 60, bubbles: true }));
    expect(onSeek).toHaveBeenLastCalledWith(1);
  });

  it("clamps a click to the left of the element to 0", () => {
    const onSeek = vi.fn();
    const { container } = render(
      <Waveform recordingId="rec-1" progress={0} onSeek={onSeek} />,
    );
    const svg = container.querySelector("svg")!;
    svg.getBoundingClientRect = () =>
      ({ left: 200, top: 0, right: 300, bottom: 120, width: 100, height: 120, x: 200, y: 0 }) as DOMRect;

    // clientX below the left edge → negative fraction → clamped to 0.
    svg.dispatchEvent(new MouseEvent("click", { clientX: 50, clientY: 60, bubbles: true }));
    expect(onSeek).toHaveBeenLastCalledWith(0);
  });
});
