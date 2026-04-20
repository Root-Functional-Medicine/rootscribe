import { Factory } from "fishery";
import { vi } from "vitest";
import type { ComponentProps } from "react";
import { InboxFilters } from "../components/InboxFilters.js";

// Factory for InboxFilters component props. Only used in
// InboxFilters.test.tsx today, but the prop shape is stable enough (8 fields)
// that a factory keeps tests from drifting when new filter axes get added.
//
// `InboxFilters` is imported as a VALUE (not `import type`) so that
// `typeof InboxFilters` resolves at the type layer — `import type` erases
// the value, which breaks `typeof` under NodeNext/ESM. `ComponentProps` is
// imported explicitly from react so we don't lean on the global React
// namespace (which isn't imported in this module).

export type InboxFiltersProps = ComponentProps<typeof InboxFilters>;

class InboxFiltersPropsFactory extends Factory<InboxFiltersProps> {
  withFilter(filter: InboxFiltersProps["filter"]): this {
    return this.params({ filter }) as this;
  }

  withTag(tag: string): this {
    return this.params({ tag }) as this;
  }

  withCategory(category: string): this {
    return this.params({ category }) as this;
  }

  withAvailableTags(...availableTags: string[]): this {
    return this.params({ availableTags }) as this;
  }

  withAvailableCategories(...availableCategories: string[]): this {
    return this.params({ availableCategories }) as this;
  }
}

export const inboxFiltersPropsFactory = InboxFiltersPropsFactory.define(
  // `as const` preserves the "all" literal through Fishery's `.define()`
  // inference (which otherwise widens string literals to `string`). Unlike
  // `as RecordingsListFilter` this stays type-safe if the union ever loses
  // "all" — TypeScript would fail here because literal "all" wouldn't
  // match the narrowed union anymore.
  () => ({
    filter: "all" as const,
    onFilterChange: vi.fn(),
    category: "",
    onCategoryChange: vi.fn(),
    tag: "",
    onTagChange: vi.fn(),
    availableTags: [],
    availableCategories: [],
  }),
);
