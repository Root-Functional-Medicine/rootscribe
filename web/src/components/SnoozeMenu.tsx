import { useEffect, useRef, useState, type RefObject, type JSX } from "react";

interface SnoozeMenuProps {
  onSelect: (snoozedUntil: number) => void;
  onClose: () => void;
  // Ref to the element that toggles this menu. mousedown inside the anchor
  // is ignored so the toggle button's click handler can fire normally —
  // otherwise the menu would close on mousedown and immediately reopen on
  // the click handler that runs right after.
  anchorRef?: RefObject<HTMLElement | null>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const PRESETS: { label: string; offsetMs: number }[] = [
  { label: "Tomorrow", offsetMs: DAY_MS },
  { label: "In 3 days", offsetMs: 3 * DAY_MS },
  { label: "Next week", offsetMs: 7 * DAY_MS },
];

function defaultCustomDate(): string {
  const d = new Date(Date.now() + DAY_MS);
  // YYYY-MM-DD format for <input type="date">. Local date, not UTC, so the
  // picker reflects what the user would write on paper for "tomorrow".
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function SnoozeMenu({
  onSelect,
  onClose,
  anchorRef,
}: SnoozeMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [customMode, setCustomMode] = useState(false);
  const [customDate, setCustomDate] = useState(defaultCustomDate());

  // Click-outside closes the menu. Use mousedown so the menu closes before the
  // click lands on a sibling element (prevents a double-click feel), but skip
  // the anchor — the toggle button needs to handle its own click without the
  // menu having already closed state mid-event and reopening.
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (ref.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, anchorRef]);

  const pickPreset = (offsetMs: number): void => {
    onSelect(Date.now() + offsetMs);
    onClose();
  };

  const pickCustom = (): void => {
    // Snooze to the END of the selected day so "snooze until tomorrow" doesn't
    // pop the recording back at midnight local time.
    const [y, m, d] = customDate.split("-").map(Number);
    if (!y || !m || !d) return;
    const target = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
    if (target <= Date.now()) return;
    onSelect(target);
    onClose();
  };

  return (
    <div
      ref={ref}
      className="absolute z-40 mt-2 w-64 rounded-xl border border-outline-variant/30 bg-surface-container-high shadow-2xl p-3"
    >
      <div className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant mb-2 px-1">
        Snooze until…
      </div>
      {!customMode && (
        <div className="flex flex-col gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => pickPreset(p.offsetMs)}
              className="text-left px-3 py-2 rounded-lg hover:bg-surface-container text-sm text-on-surface transition-colors"
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setCustomMode(true)}
            className="text-left px-3 py-2 rounded-lg hover:bg-surface-container text-sm text-on-surface-variant transition-colors"
          >
            Pick a date…
          </button>
        </div>
      )}
      {customMode && (
        <div className="flex flex-col gap-2">
          <input
            type="date"
            className="input text-sm"
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            min={defaultCustomDate()}
          />
          <div className="flex items-center gap-2">
            <button onClick={() => setCustomMode(false)} className="btn-ghost text-xs flex-1">
              Back
            </button>
            <button onClick={pickCustom} className="btn-primary text-xs flex-1">
              Snooze
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
