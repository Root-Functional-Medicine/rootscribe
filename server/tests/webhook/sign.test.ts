import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { signWebhook } from "../../src/webhook/sign.js";

// signWebhook is the single primitive both fireRaw and testWebhook use to
// produce the `v1=` half of x-rootscribe-signature. Receivers (Rootstock)
// recompute exactly this: hex HMAC-SHA256 over `${timestampSec}.${body}`.
// The known-answer test pins the wire format so a refactor that, say,
// swapped the separator or the digest encoding fails loudly here rather than
// silently breaking every receiver.

describe("signWebhook", () => {
  const secret = "whsec_test_0123456789";
  const body = '{"event":"transcript_ready","recording":{"id":"abc"}}';
  const timestampSec = 1_757_851_200;

  it("returns the lowercase hex HMAC-SHA256 of `${timestampSec}.${body}`", () => {
    const expected = createHmac("sha256", secret)
      .update(`${timestampSec}.${body}`)
      .digest("hex");

    expect(signWebhook(secret, timestampSec, body)).toBe(expected);
    expect(signWebhook(secret, timestampSec, body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the secret changes", () => {
    expect(signWebhook("other-secret", timestampSec, body)).not.toBe(
      signWebhook(secret, timestampSec, body),
    );
  });

  it("changes when the timestamp changes (replay protection input)", () => {
    expect(signWebhook(secret, timestampSec + 1, body)).not.toBe(
      signWebhook(secret, timestampSec, body),
    );
  });

  it("changes when a single byte of the body changes", () => {
    const tampered = body.replace('"abc"', '"abd"');
    expect(signWebhook(secret, timestampSec, tampered)).not.toBe(
      signWebhook(secret, timestampSec, body),
    );
  });

  it("is deterministic for identical inputs", () => {
    expect(signWebhook(secret, timestampSec, body)).toBe(
      signWebhook(secret, timestampSec, body),
    );
  });
});
