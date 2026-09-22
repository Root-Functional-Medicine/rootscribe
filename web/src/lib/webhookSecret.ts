// Mint a webhook signing secret in the browser. 32 bytes from the Web Crypto
// CSPRNG rendered as lowercase hex — 256 bits of entropy, and a value that
// pastes cleanly into any receiver config (no quoting or escaping needed).
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
