import { createHmac } from "node:crypto";

/**
 * Compute the `v1` component of an `x-rootscribe-signature` header.
 *
 * The signed string is `${timestampSec}.${body}` — the Unix timestamp
 * (seconds) that is also sent as `x-rootscribe-timestamp`, a literal `.`,
 * then the exact JSON body bytes handed to `fetch`. Receivers recompute this
 * with the shared secret and compare using a constant-time equality; the
 * README's "Webhook signing" section documents the verification recipe.
 *
 * Returned as lowercase hex so it is safe in a header value and trivially
 * comparable across languages.
 */
export function signWebhook(secret: string, timestampSec: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
}
