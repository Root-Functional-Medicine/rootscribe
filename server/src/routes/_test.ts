import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db.js";
import { resetMutableState } from "../test-seed/fixtures.js";

// E2E-only test harness router. index.ts mounts this ONLY when
// ROOTSCRIBE_E2E=1, so these routes never register in a production process.
// The router itself does not re-check the env flag — relying on the single
// mount-time gate keeps the test-only surface obvious and audit-friendly.

export const testRouter = Router();

testRouter.post("/reset", (_req, res) => {
  const db = getDb();
  resetMutableState(db);
  res.json({ ok: true });
});

const fastForwardSchema = z.object({
  recordingId: z.string().min(1),
  // Optional — defaults to "60 seconds ago" which is well past any plausible
  // snooze window we seed. Tests can override when they need a precise offset.
  snoozedUntilMs: z.number().int().optional(),
});

testRouter.post("/fast-forward-snooze", (req, res) => {
  const parsed = fastForwardSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const target = parsed.data.snoozedUntilMs ?? Date.now() - 60_000;
  const db = getDb();
  const result = db
    .prepare("UPDATE recordings SET snoozed_until = ? WHERE id = ?")
    .run(target, parsed.data.recordingId);
  res.json({ ok: true, changed: result.changes });
});
