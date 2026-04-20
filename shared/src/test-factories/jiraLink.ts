import { Factory } from "fishery";
import type { JiraLink } from "../recording.js";

// Factory for the Jira-link shape attached to RecordingDetail. Trait set
// covers the three variants that actually drive rendering in JiraLinksEditor:
//   - valid https URL → renders as an anchor
//   - null URL → renders as plain text with a "re-link" affordance
//   - unsafe scheme (javascript:) → stripped at the component boundary
// The unsafe() trait exists so coverage of that branch doesn't require
// hand-rolling an object literal at every call site.

class JiraLinkFactory extends Factory<JiraLink> {
  withoutUrl(): this {
    return this.params({ issueUrl: null }) as this;
  }

  // Stored URL with a javascript: scheme. Component tests use this to prove
  // the sanitization path strips the link rather than rendering a live anchor.
  unsafe(): this {
    return this.params({
      issueUrl: "javascript:alert('xss')", // eslint-disable-line no-script-url
    }) as this;
  }
}

export const jiraLinkFactory = JiraLinkFactory.define(({ sequence }) => ({
  id: sequence,
  issueKey: `ROOT-${100 + sequence}`,
  issueUrl: `https://example.atlassian.net/browse/ROOT-${100 + sequence}`,
  relation: "created_from",
  createdAt: Date.parse("2026-04-15T12:00:00Z"),
}));
