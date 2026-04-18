import { Router } from "express";
import { readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  listRecordingRows,
  getRecordingWithRelations,
  deleteRecording,
  setInboxStatus,
  setSnoozedUntil,
  setCategory,
  setInboxNotes,
  addRecordingTag,
  removeRecordingTag,
  addJiraLink,
  removeJiraLink,
} from "../sync/state.js";
import { loadAllTags, loadAllCategories } from "../db.js";
import { loadConfig } from "../config.js";
import { encodeFolderPath } from "../lib/url.js";
import type {
  RecordingDetail,
  InboxStatus,
  RecordingsListFilter,
} from "@rootscribe/shared";
import { isValidJiraKey } from "@rootscribe/shared";

export const recordingsRouter = Router();

function parseFilter(value: unknown): RecordingsListFilter | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value === "all" ||
    value === "active" ||
    value === "new" ||
    value === "reviewed" ||
    value === "archived" ||
    value === "snoozed"
  ) {
    return value;
  }
  return undefined;
}

// Parse query-string numbers defensively: rejects non-finite input (NaN,
// Infinity), floors to an integer, and clamps into [min, max]. Protects
// `LIMIT`/`OFFSET` from pathological inputs — e.g. SQLite treats `LIMIT -1`
// as "no limit", and fractional bindings get silently coerced downstream.
function parseIntQuery(
  value: unknown,
  { fallback, min, max }: { fallback: number; min: number; max: number },
): number {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

recordingsRouter.get("/", (req, res) => {
  // 500 is the same upper bound `listRecordingRows` clamps to — matching
  // here means pagination is predictable regardless of which layer clamps.
  // offset is capped at 1,000,000 (= 5,000 pages at 500/page) to keep
  // pagination bounded-cost and avoid large-offset DoS vectors.
  const limit = parseIntQuery(req.query.limit, { fallback: 100, min: 1, max: 500 });
  const offset = parseIntQuery(req.query.offset, { fallback: 0, min: 0, max: 1_000_000 });
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  // Trim tag/category so leading/trailing whitespace from URL-encoded inputs
  // (e.g. "?tag=foo%20") doesn't silently produce zero matches.
  const tag =
    typeof req.query.tag === "string" && req.query.tag.trim() ? req.query.tag.trim() : undefined;
  const category =
    typeof req.query.category === "string" && req.query.category.trim()
      ? req.query.category.trim()
      : undefined;
  const filter = parseFilter(req.query.filter);
  // Facets (availableTags/availableCategories) are expensive-ish DISTINCT
  // scans — only compute them when the caller asks ("?facets=1"), so
  // paging/search/filter refetches don't pay that cost.
  const facets = req.query.facets === "1" || req.query.facets === "true";
  const result = listRecordingRows({
    limit,
    offset,
    facets,
    ...(search ? { search } : {}),
    ...(filter ? { filter } : {}),
    ...(tag ? { tag } : {}),
    ...(category ? { category } : {}),
  });
  res.json(result);
});

// Build the full RecordingDetail from DB + on-disk transcript/summary/metadata.
// Extracted so mutation endpoints can reuse it without duplicating the IO.
//
// `skipFiles` lets mutation endpoints skip the disk reads for transcript/
// summary/metadata — those don't change in response to inbox mutations, and
// for frequent edits (tags/notes/category/status) rereading large transcript
// files on every call is wasted IO. The client merges the response into its
// cached detail so the null fields don't overwrite in-memory content.
interface ReadRecordingDetailOptions {
  skipFiles?: boolean;
}

function readRecordingDetail(
  id: string,
  opts: ReadRecordingDetailOptions = {},
): {
  detail: RecordingDetail;
  mediaBase: string;
  availableTags: string[];
  availableCategories: string[];
} | null {
  const rel = getRecordingWithRelations(id);
  if (!rel) return null;

  let transcriptText: string | null = null;
  let summaryMarkdown: string | null = null;
  let metadata: Record<string, unknown> | null = null;

  if (!opts.skipFiles) {
    try {
      if (rel.row.transcriptPath) {
        const txtPath = path.join(path.dirname(rel.row.transcriptPath), "transcript.txt");
        if (existsSync(txtPath)) transcriptText = readFileSync(txtPath, "utf8");
      }
    } catch {
      /* ignore */
    }
    try {
      if (rel.row.summaryPath && existsSync(rel.row.summaryPath)) {
        summaryMarkdown = readFileSync(rel.row.summaryPath, "utf8");
      }
    } catch {
      /* ignore */
    }
    try {
      if (rel.row.metadataPath && existsSync(rel.row.metadataPath)) {
        metadata = JSON.parse(readFileSync(rel.row.metadataPath, "utf8")) as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
  }

  const detail: RecordingDetail = {
    ...rel.row,
    transcriptText,
    summaryMarkdown,
    metadata,
    inboxNotes: rel.inboxNotes,
    jiraLinks: rel.jiraLinks,
  };
  return {
    detail,
    mediaBase: `/media/${encodeFolderPath(rel.row.folder)}`,
    // Two DISTINCT scans per call. Cheap on the single-detail path (hit once
    // per page load + per tag/category mutation), unlike the list endpoint
    // where high-frequency filter refetches made them an opt-in via `facets`.
    availableTags: loadAllTags(),
    availableCategories: loadAllCategories(),
  };
}

recordingsRouter.get("/:id", (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  const full = readRecordingDetail(id);
  if (!full) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const cfg = loadConfig();
  res.json({
    recording: full.detail,
    mediaBase: full.mediaBase,
    recordingsDir: cfg.recordingsDir ?? "",
    availableTags: full.availableTags,
    availableCategories: full.availableCategories,
  });
});

recordingsRouter.delete("/:id", (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  const rel = getRecordingWithRelations(id);
  if (!rel) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const cfg = loadConfig();
  if (cfg.recordingsDir) {
    const folder = path.join(cfg.recordingsDir, rel.row.folder);
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  deleteRecording(id);
  res.json({ ok: true });
});

// --- Inbox workflow mutations ---
// Each returns the updated RecordingDetail so the client can patch its cache
// without a second fetch. 404 if the recording doesn't exist; 409 if the state
// transition is invalid (e.g. snoozing a non-'new' recording).

function respondWithDetail(res: import("express").Response, id: string): void {
  // Mutation responses skip transcript/summary/metadata IO — the client keeps
  // those fields from its cached copy when merging this response.
  const full = readRecordingDetail(id, { skipFiles: true });
  if (!full) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({
    recording: full.detail,
    availableTags: full.availableTags,
    availableCategories: full.availableCategories,
  });
}

recordingsRouter.patch("/:id/status", (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  const { status, notes } = req.body ?? {};
  if (status !== "new" && status !== "reviewed" && status !== "archived") {
    res.status(400).json({ error: "status must be one of: new, reviewed, archived" });
    return;
  }
  // Notes on this endpoint are only meaningful for the `reviewed` transition
  // — `setInboxStatus` ignores them for `new`/`archived`. Reject notes on
  // other transitions rather than silently dropping them, so the wire
  // contract matches the runtime behavior. Empty/whitespace-only strings
  // normalize to "absent" (otherwise COALESCE would see "" as non-null and
  // bypass the "use PATCH /notes to clear" rule).
  if (notes !== undefined && typeof notes !== "string") {
    res.status(400).json({
      error: "notes must be a string if provided (use PATCH /notes to clear notes)",
    });
    return;
  }
  if (notes !== undefined && status !== "reviewed") {
    res.status(400).json({
      error: "notes may only be provided when status is 'reviewed'",
    });
    return;
  }
  const notesArg: string | null =
    typeof notes === "string" && notes.trim() !== "" ? notes : null;
  const changed = setInboxStatus(id, status as InboxStatus, notesArg);
  if (!changed) {
    // `setInboxStatus` returns changes > 0. A no-op update (recording exists
    // but is already in the requested status — common for idempotent clients
    // or double-click) would otherwise surface as 404, so we disambiguate.
    const exists = getRecordingWithRelations(id);
    if (!exists) {
      res.status(404).json({ error: "not found" });
      return;
    }
  }
  respondWithDetail(res, id);
});

recordingsRouter.patch("/:id/snooze", (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  // The contract is "explicit epoch-ms or explicit null" — an empty body must
  // fail loudly instead of silently unsnoozing, which is a surprising outcome
  // for a route named /snooze.
  const body: Record<string, unknown> = (req.body as Record<string, unknown>) ?? {};
  if (!Object.prototype.hasOwnProperty.call(body, "snoozedUntil")) {
    res.status(400).json({ error: "snoozedUntil field is required (pass null to unsnooze)" });
    return;
  }
  const raw = body.snoozedUntil;
  let until: number | null;
  if (raw === null) {
    until = null;
  } else if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    // Reject past/near-now timestamps: the snooze predicate is
    // `snoozed_until > now`, so a stale value would persist without
    // actually snoozing the item. Fail fast instead of silently misleading.
    if (raw <= Date.now()) {
      res.status(400).json({ error: "snoozedUntil must be in the future" });
      return;
    }
    until = raw;
  } else {
    res.status(400).json({ error: "snoozedUntil must be a positive epoch-ms number or null" });
    return;
  }
  const changed = setSnoozedUntil(id, until);
  if (!changed) {
    // Either not found or not in 'new' status — check which.
    const rel = getRecordingWithRelations(id);
    if (!rel) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (until !== null && rel.row.inboxStatus !== "new") {
      res.status(409).json({ error: "can only snooze recordings in 'new' status" });
      return;
    }
    // Otherwise the new value equals the existing value — treat as success.
  }
  respondWithDetail(res, id);
});

recordingsRouter.patch("/:id/category", (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  // Require the field so a missing-key request returns an explicit "required"
  // error instead of the misleading type-check message.
  const body: Record<string, unknown> = (req.body as Record<string, unknown>) ?? {};
  if (!Object.prototype.hasOwnProperty.call(body, "category")) {
    res.status(400).json({ error: "category field is required (pass null to clear)" });
    return;
  }
  const raw = body.category;
  if (raw !== null && typeof raw !== "string") {
    res.status(400).json({ error: "category must be a string or null" });
    return;
  }
  const exists = getRecordingWithRelations(id);
  if (!exists) {
    res.status(404).json({ error: "not found" });
    return;
  }
  setCategory(id, raw);
  respondWithDetail(res, id);
});

recordingsRouter.patch("/:id/notes", (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  // Same explicit-required pattern as /category and /snooze — differentiates
  // "missing field" from "wrong type" for the caller.
  const body: Record<string, unknown> = (req.body as Record<string, unknown>) ?? {};
  if (!Object.prototype.hasOwnProperty.call(body, "notes")) {
    res.status(400).json({ error: "notes field is required (pass null to clear)" });
    return;
  }
  const raw = body.notes;
  if (raw !== null && typeof raw !== "string") {
    res.status(400).json({ error: "notes must be a string or null" });
    return;
  }
  const exists = getRecordingWithRelations(id);
  if (!exists) {
    res.status(404).json({ error: "not found" });
    return;
  }
  setInboxNotes(id, raw);
  respondWithDetail(res, id);
});

recordingsRouter.post("/:id/tags", (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  const tag = req.body?.tag;
  if (typeof tag !== "string" || !tag.trim()) {
    res.status(400).json({ error: "tag must be a non-empty string" });
    return;
  }
  const exists = getRecordingWithRelations(id);
  if (!exists) {
    res.status(404).json({ error: "not found" });
    return;
  }
  addRecordingTag(id, tag);
  respondWithDetail(res, id);
});

recordingsRouter.delete("/:id/tags/:tag", (req, res) => {
  const id = req.params.id;
  const tag = req.params.tag;
  if (!id || !tag) {
    res.status(400).json({ error: "missing id or tag" });
    return;
  }
  // `addRecordingTag` trims before insert, so delete must trim too —
  // otherwise a client sending `/tags/%20foo%20` silently no-ops against
  // the stored canonical `foo`.
  const normalizedTag = tag.trim();
  if (!normalizedTag) {
    res.status(400).json({ error: "tag must be a non-empty string" });
    return;
  }
  const exists = getRecordingWithRelations(id);
  if (!exists) {
    res.status(404).json({ error: "not found" });
    return;
  }
  removeRecordingTag(id, normalizedTag);
  respondWithDetail(res, id);
});

recordingsRouter.post("/:id/jira-links", (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  const { issueKey, issueUrl, relation } = req.body ?? {};
  if (typeof issueKey !== "string" || !issueKey.trim()) {
    res.status(400).json({ error: "issueKey must be a non-empty string" });
    return;
  }
  const normalizedKey = issueKey.trim().toUpperCase();
  // DB schema doesn't enforce a key pattern, so the server validates here
  // using the same helper the client uses — otherwise a malformed key could
  // persist and break the "key → URL" assumption in the UI.
  if (!isValidJiraKey(normalizedKey)) {
    res.status(400).json({ error: "issueKey must be a valid Jira key (e.g. DEVX-96)" });
    return;
  }
  if (issueUrl !== undefined && issueUrl !== null && typeof issueUrl !== "string") {
    res.status(400).json({ error: "issueUrl must be a string or null" });
    return;
  }
  // Validate the URL scheme: javascript:/data:/about: etc. would be rendered
  // into an <a href> on the client and become XSS/navigation vectors. Only
  // http/https are permitted for persisted Jira URLs.
  let normalizedUrl: string | null = null;
  if (typeof issueUrl === "string" && issueUrl.trim()) {
    const trimmedUrl = issueUrl.trim();
    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        res.status(400).json({ error: "issueUrl must use http or https scheme" });
        return;
      }
      normalizedUrl = trimmedUrl;
    } catch {
      res.status(400).json({ error: "issueUrl must be a valid absolute URL" });
      return;
    }
  }
  if (relation !== undefined && typeof relation !== "string") {
    res.status(400).json({ error: "relation must be a string" });
    return;
  }
  const exists = getRecordingWithRelations(id);
  if (!exists) {
    res.status(404).json({ error: "not found" });
    return;
  }
  addJiraLink({
    recordingId: id,
    issueKey: normalizedKey,
    issueUrl: normalizedUrl,
    relation: (relation as string) || "created_from",
  });
  respondWithDetail(res, id);
});

recordingsRouter.delete("/:id/jira-links/:issueKey", (req, res) => {
  const id = req.params.id;
  const issueKey = req.params.issueKey;
  if (!id || !issueKey) {
    res.status(400).json({ error: "missing id or issueKey" });
    return;
  }
  const exists = getRecordingWithRelations(id);
  if (!exists) {
    res.status(404).json({ error: "not found" });
    return;
  }
  // POST uppercases keys before insert, so DELETE must normalize the same
  // way or case-mismatched URLs will fail to remove the stored row.
  removeJiraLink(id, issueKey.trim().toUpperCase());
  respondWithDetail(res, id);
});
