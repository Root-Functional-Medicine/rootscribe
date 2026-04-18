import type { JSX } from "react";
import type { EffectiveInboxStatus } from "@rootscribe/shared";

// Maps each status to a token in the existing design system. Kept next to the
// component (instead of as a standalone util) because the styling for "dot color"
// and "text color" stay in lockstep by convention.
const STATUS_STYLE: Record<
  EffectiveInboxStatus,
  { label: string; text: string; dot: string }
> = {
  new: { label: "NEW", text: "text-primary", dot: "bg-primary" },
  reviewed: { label: "REVIEWED", text: "text-secondary", dot: "bg-secondary" },
  snoozed: { label: "SNOOZED", text: "text-tertiary", dot: "bg-tertiary" },
  archived: { label: "ARCHIVED", text: "text-on-surface-variant", dot: "bg-outline-variant" },
};

export function InboxStatusPill({
  status,
  size = "md",
}: {
  status: EffectiveInboxStatus;
  size?: "sm" | "md";
}): JSX.Element {
  const style = STATUS_STYLE[status];
  const padding = size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full bg-surface-container-highest font-label font-bold uppercase tracking-widest ${padding} ${style.text}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}
