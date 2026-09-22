import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordingRowFactory } from "@rootscribe/shared/test-factories";
import { cleanupTempDir, mkTempConfigDir } from "../helpers/test-server.js";

// The "deliveries are unsigned" warning is a module-level latch in
// webhook/post.ts: it fires on the first unsigned delivery of a process and
// never again. That latch is per module instance, so this lives in its own
// file (Vitest isolates modules per file) instead of post.test.ts, where
// earlier cases would have already tripped it and made "exactly once"
// order-dependent.

vi.mock("../../src/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const originalConfigDir = process.env.ROOTSCRIBE_CONFIG_DIR;
const configDir = mkTempConfigDir("rootscribe-webhook-unsigned-");

const { fireWebhookForRecording, testWebhook } = await import("../../src/webhook/post.js");
const { resetConfigCache, updateConfig } = await import("../../src/config.js");
const { getDb, resetDbSingleton } = await import("../../src/db.js");
const { logger } = await import("../../src/logger.js");

afterAll(() => {
  resetConfigCache();
  resetDbSingleton();
  cleanupTempDir(configDir);
  if (originalConfigDir == null) delete process.env.ROOTSCRIBE_CONFIG_DIR;
  else process.env.ROOTSCRIBE_CONFIG_DIR = originalConfigDir;
});

function unsignedWarnings(): number {
  return vi
    .mocked(logger.warn)
    .mock.calls.filter((call) => call.some((arg) => typeof arg === "string" && /unsigned/i.test(arg)))
    .length;
}

describe("unsigned-delivery warning", () => {
  beforeEach(() => {
    resetConfigCache();
    resetDbSingleton();
    getDb();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("warns exactly once across many unsigned deliveries (real and test)", async () => {
    updateConfig({
      webhook: { url: "https://hook.example/ingest", enabled: true },
      instanceId: "inst-warn",
    });
    const row = recordingRowFactory.build({ audioDownloadedAt: Date.now(), audioPath: "audio.ogg" });

    await fireWebhookForRecording("audio_ready", row);
    await fireWebhookForRecording("transcript_ready", row);
    await testWebhook("https://hook.example/ingest");

    expect(unsignedWarnings()).toBe(1);
  });

  it("never warns once a secret is configured", async () => {
    updateConfig({
      webhook: { url: "https://hook.example/ingest", enabled: true, secret: "whsec_x" },
      instanceId: "inst-signed",
    });
    const before = unsignedWarnings();
    await fireWebhookForRecording(
      "audio_ready",
      recordingRowFactory.build({ audioDownloadedAt: Date.now(), audioPath: "audio.ogg" }),
    );
    expect(unsignedWarnings()).toBe(before);
  });
});
