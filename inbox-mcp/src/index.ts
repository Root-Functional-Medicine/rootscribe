#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addTags,
  archive,
  categorize,
  getJiraLinks,
  getRecording,
  getTags,
  linkJira,
  listNew,
  markNotified,
  markReviewed,
  readSummaryMarkdown,
  readTranscriptText,
  recent,
  removeTags,
  search,
  snooze,
  unlinkJira,
  unnotifiedNew,
  unsnooze,
} from "./db.js";

const server = new McpServer(
  {
    name: "rootscribe-inbox",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  },
);

// ─── helpers ──────────────────────────────────────────────────────────────

function asText(obj: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function summarizeRow(r: ReturnType<typeof getRecording>): Record<string, unknown> | null {
  if (!r) return null;
  return {
    id: r.id,
    filename: r.filename,
    start_time_iso: new Date(r.start_time).toISOString(),
    duration_seconds: Math.round(r.duration_ms / 1000),
    status: r.inbox_status,
    category: r.category,
    reviewed_at: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
  };
}

// ─── tools ────────────────────────────────────────────────────────────────

server.tool(
  "list_new",
  "List unreviewed transcripts (status=new), newest first. Optional filtering by category or tag.",
  {
    limit: z.number().int().positive().max(200).optional(),
    category: z.string().optional(),
    tag: z.string().optional(),
  },
  async ({ limit, category, tag }) => {
    const rows = listNew({ limit, category, tag });
    return asText(rows.map(summarizeRow));
  },
);

server.tool(
  "recent",
  "Recent recordings across all inbox statuses (optionally filtered by status), newest first.",
  {
    limit: z.number().int().positive().max(200).optional(),
    status: z.enum(["new", "reviewed", "archived", "snoozed"]).optional(),
  },
  async ({ limit, status }) => {
    const rows = recent({ limit, status });
    return asText(rows.map(summarizeRow));
  },
);

server.tool(
  "get",
  "Fetch a recording's full metadata, transcript text, summary markdown, tags, and Jira links.",
  {
    recording_id: z.string().min(1),
  },
  async ({ recording_id }) => {
    const row = getRecording(recording_id);
    if (!row) return asText({ error: "not found", recording_id });
    return asText({
      ...summarizeRow(row),
      folder: row.folder,
      inbox_notes: row.inbox_notes,
      tags: getTags(recording_id),
      jira_links: getJiraLinks(recording_id),
      transcript_text: readTranscriptText(row),
      summary_markdown: readSummaryMarkdown(row),
    });
  },
);

server.tool(
  "search",
  "Case-insensitive substring search across filename and transcript text.",
  {
    query: z.string().min(1),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ query, limit }) => {
    const rows = search(query, limit);
    return asText(rows.map(summarizeRow));
  },
);

server.tool(
  "mark_reviewed",
  "Mark a recording as reviewed. Optionally attach notes.",
  {
    recording_id: z.string().min(1),
    notes: z.string().optional(),
  },
  async ({ recording_id, notes }) => {
    const ok = markReviewed(recording_id, notes ?? null);
    return asText({ ok, recording_id });
  },
);

server.tool(
  "archive",
  "Move a recording to status=archived (hidden from list_new).",
  { recording_id: z.string().min(1) },
  async ({ recording_id }) => asText({ ok: archive(recording_id), recording_id }),
);

server.tool(
  "snooze",
  "Snooze a recording until a specific Unix epoch ms; reappears in list_new after that time.",
  {
    recording_id: z.string().min(1),
    until_epoch_ms: z.number().int().positive(),
  },
  async ({ recording_id, until_epoch_ms }) =>
    asText({ ok: snooze(recording_id, until_epoch_ms), recording_id }),
);

server.tool(
  "unsnooze",
  "Clear snooze and return a recording to status=new.",
  { recording_id: z.string().min(1) },
  async ({ recording_id }) => asText({ ok: unsnooze(recording_id), recording_id }),
);

server.tool(
  "categorize",
  "Set or clear a free-form category on a recording. Pass null/empty to clear.",
  {
    recording_id: z.string().min(1),
    category: z.string().nullable(),
  },
  async ({ recording_id, category }) => {
    const value = category && category.length > 0 ? category : null;
    return asText({ ok: categorize(recording_id, value), recording_id, category: value });
  },
);

server.tool(
  "tag",
  "Add one or more tags to a recording.",
  {
    recording_id: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1),
  },
  async ({ recording_id, tags }) => asText({ added: addTags(recording_id, tags), recording_id, tags }),
);

server.tool(
  "untag",
  "Remove one or more tags from a recording.",
  {
    recording_id: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1),
  },
  async ({ recording_id, tags }) =>
    asText({ removed: removeTags(recording_id, tags), recording_id, tags }),
);

server.tool(
  "link_jira",
  "Attach a Jira issue key to a recording (e.g. after creating a ticket). Relation defaults to 'created_from'.",
  {
    recording_id: z.string().min(1),
    issue_key: z.string().min(1),
    issue_url: z.string().url().optional(),
    relation: z.enum(["created_from", "mentioned", "related"]).optional(),
  },
  async ({ recording_id, issue_key, issue_url, relation }) => {
    const ok = linkJira({
      recordingId: recording_id,
      issueKey: issue_key,
      issueUrl: issue_url ?? null,
      relation: relation ?? "created_from",
    });
    return asText({ ok, recording_id, issue_key });
  },
);

server.tool(
  "unlink_jira",
  "Remove a Jira link from a recording.",
  {
    recording_id: z.string().min(1),
    issue_key: z.string().min(1),
  },
  async ({ recording_id, issue_key }) =>
    asText({ ok: unlinkJira(recording_id, issue_key), recording_id, issue_key }),
);

// ─── Channels nudge: emit a notification per not-yet-notified 'new' row ────
// Uses a periodic timer; fires per-row then marks channel_notified_at so we
// don't re-nudge. The server process on the other side is what populates
// the rows; we're just the bridge into the connected Claude Code session.

async function emitChannelNudges(): Promise<void> {
  try {
    const pending = unnotifiedNew();
    for (const row of pending) {
      const text = `New transcript: "${row.filename}" (${Math.round(row.duration_ms / 1000)}s). Use list_new to review.`;
      let delivered = false;
      // `notifications/claude/channel` is the Claude Code Channels API (research preview,
      // v2.1.80+). If the client doesn't implement it, the notification is silently dropped.
      try {
        await server.server.notification({
          method: "notifications/claude/channel",
          params: { kind: "inbox.new_transcript", recording_id: row.id, text },
        });
        delivered = true;
      } catch {
        /* best effort — fall through to logging channel */
      }
      // Also send a standard logging/message notification so it shows up even
      // without Channels support.
      try {
        await server.server.notification({
          method: "notifications/message",
          params: { level: "info", data: text },
        });
        delivered = true;
      } catch {
        /* best effort */
      }
      // Only mark as notified if at least one channel actually accepted the
      // send. Otherwise leave channel_notified_at NULL so the next poll retries
      // — prevents a broken stdio pipe from permanently silencing a recording.
      if (delivered) markNotified(row.id);
    }
  } catch {
    /* swallow — best effort, we'll retry on the next tick */
  }
}

const POLL_MS = 30_000;
let pollTimer: NodeJS.Timeout | null = null;

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Kick one off immediately after connect so current backlog gets nudged,
  // then keep polling while the session is open.
  void emitChannelNudges();
  pollTimer = setInterval(() => void emitChannelNudges(), POLL_MS);

  const cleanup = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    // Explicit exit — `server.connect()` keeps the event loop alive via stdio,
    // so without this the process hangs after the signal.
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

main().catch((err) => {
  process.stderr.write(`[rootscribe-inbox-mcp] fatal: ${String(err)}\n`);
  process.exit(1);
});
