import { describe, expect, it } from "vitest";
import { generateWebhookSecret } from "./webhookSecret.js";

// The "Generate" button in Settings and the setup wizard both call this.
// 32 random bytes rendered as hex gives 256 bits of entropy in a value that
// is safe to paste anywhere (no quoting, no shell-special characters).

describe("generateWebhookSecret", () => {
  it("returns 64 lowercase hex characters (32 random bytes)", () => {
    expect(generateWebhookSecret()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different value on every call", () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateWebhookSecret()));
    expect(seen.size).toBe(20);
  });
});
