# RootScribe

A self-hosted local server that mirrors your [Plaud](https://plaud.ai) recordings to disk and fires webhooks when new recordings or transcripts arrive, so you can easily hook it up to n8n (or any other custom integration). Runs on your machine, uses your existing Plaud browser session for auth, and ships with a web UI for setup and browsing.

> RootScribe is not affiliated with Plaud. It talks to the same undocumented web API that the Plaud web app uses, via your own logged-in session.

![Recordings dashboard](assets/Screenshot%202026-04-11%20203407.png)

## Features

- **Automatic sync** — polls Plaud every 10 minutes (configurable) and downloads audio, transcripts, and AI summaries to local disk
- **Full-text search** — search recordings by filename or transcript content
- **Audio player** — custom player with waveform visualization, play/pause, skip -10s/+30s, click-to-seek
- **Transcript viewer** — speaker-labeled, timestamped, color-coded blocks with auto-scroll during playback, click-to-seek, and full-text search within transcripts
- **AI summaries** — rendered markdown with expandable full-screen modal for long summaries
- **Webhooks** — POST JSON payloads on `audio_ready` and `transcript_ready` events for n8n, Zapier, or custom integrations
- **Dark & light mode** — toggle between themes, defaults to system preference
- **Setup wizard** — guided 5-step onboarding (auth, folder, webhook, review)

![Recording detail](assets/Screenshot%202026-04-11%20203843.png)

## Install

First, you should never run commands you find on the internet that end in `| sh`. With that said, here's the easiest way to install RootScribe:

**macOS / Linux / WSL:**
```bash
curl -fsSL https://raw.githubusercontent.com/Root-Functional-Medicine/rootscribe/v0.5.6/install.sh | sh
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/Root-Functional-Medicine/rootscribe/v0.5.6/install.ps1 | iex
```

The installer does everything needed to install RootScribe into a subfolder named `./rootscribe`. To run it:

```bash
cd rootscribe
pnpm start
```

Your browser will open to `http://127.0.0.1:44471/setup`. Walk through the 5-step wizard and you're done.

### Manual install

```bash
git clone https://github.com/Root-Functional-Medicine/rootscribe.git
cd rootscribe
pnpm install
pnpm build
pnpm start
```

Requires Node.js >= 20 and pnpm >= 9.

## How it works

1. **Auth:** RootScribe reads your existing Plaud session from Chrome (or Edge / Brave / Arc / Vivaldi) by copying the browser's `Local Storage/leveldb` directory to a temp path (which sidesteps Chrome's file lock) and pulling the JWT bearer from the `tokenstr` key for `web.plaud.ai`. No passwords, no OAuth, no Playwright — just your existing session. Tokens are good for ~10 months.

2. **Sync:** every 10 minutes (configurable), the server calls `/file/simple/web` on `api.plaud.ai` to list your latest recordings. New ones get a per-recording subfolder, their audio streamed down from S3, and — once Plaud finishes transcribing — transcript + summary pulled via `/ai/transsumm/` (with S3 fallback for older recordings).

3. **Webhook:** if configured, RootScribe POSTs a JSON payload to your URL whenever a new `audio_ready` or `transcript_ready` event happens. Includes file paths (relative to your recordings dir) plus ready-to-fetch HTTP URLs that the local media server serves, and — on `transcript_ready` — the flattened transcript text and summary markdown inline so n8n-style workflows don't need a second fetch.

## Folder layout

Each recording gets its own folder under your chosen recordings directory:

```
<recordings-dir>/
  2026-04-11_My_meeting_title__74560101/
    audio.ogg
    transcript.json     # raw Plaud transcript segments (with speaker embeddings)
    transcript.txt      # speaker-labeled, timestamped plaintext
    summary.md          # Plaud's AI-generated summary (when available)
    metadata.json       # full /file/detail response
```

## Webhook payload

```json
{
  "event": "audio_ready | transcript_ready",
  "recording": {
    "id": "74560101636422f79bacd66696bab17b",
    "filename": "04-11 Validation of Automated Transcription...",
    "start_time_ms": 1775929909000,
    "duration_ms": 22000,
    "filesize_bytes": 95744,
    "serial_number": "8810B30227298497"
  },
  "files": {
    "folder": "2026-04-11_...__74560101",
    "audio": "2026-04-11_...__74560101/audio.ogg",
    "transcript": "2026-04-11_...__74560101/transcript.json",
    "summary": "2026-04-11_...__74560101/summary.md"
  },
  "http_urls": {
    "audio": "http://127.0.0.1:44471/media/2026-04-11_...__74560101/audio.ogg",
    "transcript": "http://127.0.0.1:44471/media/2026-04-11_...__74560101/transcript.json",
    "summary": "http://127.0.0.1:44471/media/2026-04-11_...__74560101/summary.md"
  },
  "content": {
    "transcript_text": "[00:01] Speaker: ...",
    "summary_markdown": "## Core Synopsis\n\n..."
  }
}
```

- `content` is only present on `transcript_ready` events. Both fields are nullable — if Plaud didn't generate a summary for a recording, `summary_markdown` will be `null`.
- Webhook consumers should treat `(id, event)` as idempotent. `audio_ready` always fires before `transcript_ready`; on recordings that are already fully transcribed when first seen, both fire back-to-back in the same poll cycle.
- Custom headers on every webhook: `User-Agent: rootscribe/0.1.0` and `X-RootScribe-Event: audio_ready|transcript_ready`.

## n8n workflows

The `n8n/` folder contains importable n8n workflow templates. To use one, open n8n, create a new workflow, then **Import from File** and select the JSON file. See [`n8n/README.md`](n8n/README.md) for setup details.

![n8n workflow](assets/Screenshot%202026-04-11%20205220.png)

![Settings](assets/Screenshot%202026-04-11%20204912.png)

## Docker

Pull the pre-built image and run:

```bash
docker run -d \
  --name rootscribe \
  -p 44471:44471 \
  -v rootscribe-config:/data/config \
  -v rootscribe-recordings:/data/recordings \
  ghcr.io/root-functional-medicine/rootscribe:latest
```

Or build from source:

```bash
docker build -t rootscribe .
docker run -d \
  --name rootscribe \
  -p 44471:44471 \
  -v rootscribe-config:/data/config \
  -v rootscribe-recordings:/data/recordings \
  rootscribe
```

Open `http://localhost:44471/setup` to configure. On first run, the setup wizard will ask you to paste your Plaud token manually (browser auto-detect doesn't work inside a container).

## Running in the background

RootScribe is a foreground process. To keep it running without a terminal:

**macOS (launchd):** create `~/Library/LaunchAgents/dev.rootscribe.plist` pointing to `pnpm start` in the install dir.

**Linux (systemd user):** create `~/.config/systemd/user/rootscribe.service` with `ExecStart=pnpm --dir=%h/rootscribe start`.

**Both platforms:** or just run it inside `tmux` / `screen`.

## Config

Settings live in `~/.config/rootscribe/settings.json` (or `~/Library/Application Support/rootscribe/` on macOS, `%APPDATA%\rootscribe\` on Windows). Recording state is in `state.sqlite` alongside. Both are managed through the web UI — you shouldn't need to edit them by hand.

The bearer token is stored as plaintext in `settings.json` (with `chmod 600`). The file lives in a user-only directory, and the token's scope is equivalent to "read this user's own Plaud data." OS keychain integration is a future enhancement.

## Development

```bash
pnpm dev
```

Runs the Vite dev server on port 44470 with a proxy for `/api` and `/media` to the Express server on port 44471. The server runs in `tsx watch` mode. Hot reload works on both sides.

## Running tests

All four workspace packages (`shared`, `server`, `web`, `inbox-mcp`) share one test harness: Vitest for unit + integration, Playwright for end-to-end user journeys. A single root command exercises the whole suite.

```bash
# Unit + integration, every package
pnpm test

# Watch mode
pnpm test:watch

# With V8 coverage (HTML + LCOV + json-summary)
pnpm test:coverage

# End-to-end (Playwright, chromium, headless)
pnpm test:e2e

# E2E with a visible browser (handy while authoring specs)
pnpm test:e2e:headed

# Open the HTML report after a failed E2E run
pnpm test:e2e:report

# Everything CI runs, sequenced locally
pnpm ci
```

Individual package suites can be run with `pnpm -C <package> vitest run` (e.g. `pnpm -C server vitest run`).

### Philosophy

- **Test real behavior, not mocks.** Server tests hit real Express routes via `supertest`; database tests use real SQLite against tmp fixtures; web component tests render with `@testing-library/react` against the real React tree. Mocks are reserved for the network boundary (see `web/src/api.test.ts`).
- **One test harness per package.** Each package declares its own `vitest.config.ts` (environment, setup, aliases). The root `vitest.config.ts` discovers them via its inline `test.projects` array (Vitest 4's replacement for the old `vitest.workspace.ts`); coverage is aggregated across all four.
- **TDD is the default.** Write the test first, watch it fail, make it pass. See `SproutKit:test-driven-development` for the workflow this repo expects.

### Coverage

Coverage is tracked across lines, branches, functions, and statements (V8 provider). The root `vitest.config.ts` enforces baseline thresholds on every `pnpm test:coverage` run.

Current baseline (Apr 2026, Vitest 4): **~10% lines, ~7% branches, ~11% functions, ~10% statements**. The numbers dropped vs. the earlier Vitest-2 baseline (~19% lines / ~78% branches / ~28% functions) because Vitest 4's v8 provider counts branches roughly 5.8× more granularly — actual test coverage is unchanged. The ratcheting plan lives in the "Increase test coverage to 95%" follow-up Story — each PR there bumps thresholds +5% until every axis sits ≥ 95%.

CI uploads the HTML coverage report as a workflow artifact and posts a per-PR summary comment via `davelosert/vitest-coverage-report-action`.

### Directory layout

```
rootscribe/
├── .github/workflows/
│   ├── ci.yml           # lint + typecheck + unit/integration + coverage gate
│   └── e2e.yml          # Playwright smoke (chromium, headless, artifacts on failure)
├── vitest.config.ts     # inline project discovery + coverage aggregation + thresholds
├── vitest.shared.ts     # shared exclude patterns + reporter wiring
├── playwright.config.ts # chromium project, traces on retry, HTML reporter
├── eslint.config.js     # flat config (ESLint 10) + vitest/testing-library plugins
├── tests/e2e/           # cross-package user journeys
└── <package>/
    ├── vitest.config.ts # per-package environment + setup
    ├── src/**/*.test.ts # co-located unit tests
    └── tests/           # integration tests (supertest, SQLite fixtures)
```

## CI/CD

Two GitHub Actions workflows gate every PR against `main`:

- **`ci.yml`** — installs dependencies, runs ESLint, typechecks all four packages, executes the Vitest suite with coverage on Node 20 and 22, uploads artifacts, and posts a coverage summary comment.
- **`e2e.yml`** — builds the production bundle, installs Chromium, runs Playwright smoke tests against a scratch `ROOTSCRIBE_CONFIG_DIR`, and uploads traces + videos on failure.

Once both workflows are green on a PR, require the `CI / test` and `E2E / playwright` checks in branch protection on `main` (admin step, not automated here).

## Contributing

- **Follow TDD.** Red → green → refactor, one commit per cycle where practical.
- **Touch production code only to fix bugs the tests surface.** Refactors, style tweaks, and speculative abstractions belong in their own tickets.
- **Run `pnpm ci` before pushing.** Matches exactly what GitHub Actions will run.
- **Avoid the anti-patterns in `SproutKit:testing-anti-patterns`.** In particular: don't test mock behavior, don't add test-only methods to production classes, and don't mock something you don't understand.

## License

MIT
