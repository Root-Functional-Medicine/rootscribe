import type { JSX } from "react";
import type { RecordingsListFilter } from "@rootscribe/shared";

interface InboxFiltersProps {
  filter: RecordingsListFilter;
  onFilterChange: (filter: RecordingsListFilter) => void;
  category: string;
  onCategoryChange: (category: string) => void;
  tag: string;
  onTagChange: (tag: string) => void;
  availableTags: string[];
  availableCategories: string[];
}

const FILTER_TABS: { value: RecordingsListFilter; label: string; description: string }[] = [
  { value: "all", label: "All", description: "Every recording" },
  { value: "active", label: "Active", description: "New & not snoozed — the inbox-zero view" },
  { value: "reviewed", label: "Reviewed", description: "Already processed" },
  { value: "snoozed", label: "Snoozed", description: "Snoozed until a future date" },
  { value: "archived", label: "Archived", description: "Hidden from default views" },
];

export function InboxFilters({
  filter,
  onFilterChange,
  category,
  onCategoryChange,
  tag,
  onTagChange,
  availableTags,
  availableCategories,
}: InboxFiltersProps): JSX.Element {
  return (
    <div className="space-y-3">
      {/* Status filters — semantically a toggle group (one active selection),
          not WAI-ARIA tabs. Using aria-pressed avoids implying tab keyboard
          semantics (arrow navigation, tabpanel linkage) that this component
          doesn't implement. */}
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Filter by inbox status"
      >
        {FILTER_TABS.map((t) => {
          // The Active tab also highlights for ?filter=new deep links — the
          // server treats them equivalently and no "new" tab exists here.
          const active =
            filter === t.value || (t.value === "active" && filter === "new");
          return (
            <button
              key={t.value}
              type="button"
              aria-pressed={active}
              title={t.description}
              onClick={() => onFilterChange(t.value)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-label font-bold uppercase tracking-widest transition-colors ${
                active
                  ? "bg-primary text-on-primary shadow-sm shadow-primary/20"
                  : "bg-surface-container-highest text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Secondary filters — tag + category, both free-text with datalist suggestions */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1.5">
          <span className="font-label uppercase tracking-widest text-on-surface-variant">Tag</span>
          <input
            className="input py-1 w-36 text-xs"
            placeholder="any"
            value={tag}
            onChange={(e) => onTagChange(e.target.value)}
            list="inbox-tags-list"
          />
          <datalist id="inbox-tags-list">
            {availableTags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          {tag && (
            <button
              type="button"
              onClick={() => onTagChange("")}
              className="text-on-surface-variant hover:text-on-surface text-[10px] uppercase tracking-widest font-label"
            >
              clear
            </button>
          )}
        </label>

        <label className="flex items-center gap-1.5">
          <span className="font-label uppercase tracking-widest text-on-surface-variant">Category</span>
          <input
            className="input py-1 w-40 text-xs"
            placeholder="any"
            value={category}
            onChange={(e) => onCategoryChange(e.target.value)}
            list="inbox-categories-list"
          />
          <datalist id="inbox-categories-list">
            {availableCategories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          {category && (
            <button
              type="button"
              onClick={() => onCategoryChange("")}
              className="text-on-surface-variant hover:text-on-surface text-[10px] uppercase tracking-widest font-label"
            >
              clear
            </button>
          )}
        </label>
      </div>
    </div>
  );
}
