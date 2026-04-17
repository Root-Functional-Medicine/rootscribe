# @rootscribe/inbox-mcp

An MCP (Model Context Protocol) server that exposes the Rootscribe/Applaud recording inbox to Claude Code. Reads the same `state.sqlite` the Applaud server writes to, and provides tools for listing new transcripts, reading transcript/summary text, tagging/categorizing, linking Jira issues, and snoozing/archiving.

## Install

From the Rootscribe repo root:

```bash
pnpm install
pnpm --filter @rootscribe/inbox-mcp build
```

## Register with Claude Code

User-scope registration (available from any working directory):

```bash
claude mcp add rootscribe-inbox --scope user -- \
  node /absolute/path/to/rootscribe/inbox-mcp/dist/index.js
```

## Tools

| Tool | Purpose |
|---|---|
| `list_new` | Unreviewed transcripts, newest first. Filters: `limit`, `category`, `tag`. |
| `recent` | Recent recordings across any status. |
| `get` | Full metadata + transcript + summary + tags + jira links for one recording. |
| `search` | Substring match across filename + transcript text. |
| `mark_reviewed` | Flip status to `reviewed`, optional notes. |
| `archive` / `snooze` / `unsnooze` | Status transitions. |
| `categorize` | Set free-form single category. |
| `tag` / `untag` | Add/remove one or more tags. |
| `link_jira` / `unlink_jira` | Record Jira issue associations. |

## Channels nudges

When Claude Code has this MCP server connected, the server polls `state.sqlite` every 30s for new transcripts that haven't been notified yet and emits:

- `notifications/claude/channel` (Claude Code Channels research-preview API, v2.1.80+)
- `notifications/message` (fallback, should surface as a log message in the session)

Per-row state is tracked in `recordings.channel_notified_at`; each recording is nudged at most once.

## Data location

Reads from the same config dir Applaud uses:

- **macOS**: `~/Library/Application Support/applaud/state.sqlite`
- **Linux**: `$XDG_CONFIG_HOME/applaud/state.sqlite` (or `~/.config/applaud/`)
- **Windows**: `%APPDATA%\applaud\state.sqlite`

Override with `APPLAUD_CONFIG_DIR` env var.
