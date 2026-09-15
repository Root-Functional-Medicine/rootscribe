import { describe, expectTypeOf, it } from "vitest";
import type { AppConfig, ConfigResponse } from "./index.js";

describe("ConfigResponse — the redacted read shape of GET/POST /api/config", () => {
  // Copilot review on PR #19 round 23 (suppressed finding): `ConfigResponse`
  // aliased `AppConfig`, so adding `secret?` to the persisted webhook shape
  // made the shared RESPONSE type advertise a field `redactForClient()`
  // deliberately strips. A client could legally read
  // `config.webhook.secret`, always get `undefined`, and never learn that
  // the field is write-only on the wire.
  // eslint-disable-next-line vitest/expect-expect -- the assertions are compile-time (expectTypeOf); `pnpm typecheck` is what fails when they do
  it("never carries the signing secret, while the patch/persisted shape still does", () => {
    type ResponseWebhook = NonNullable<ConfigResponse["config"]["webhook"]>;
    expectTypeOf<ResponseWebhook>().not.toHaveProperty("secret");
    // The read side reports whether one is stored instead.
    expectTypeOf<ResponseWebhook>().toHaveProperty("secretConfigured");
    // The write side (POST patch / on-disk shape) keeps the field.
    expectTypeOf<NonNullable<AppConfig["webhook"]>>().toHaveProperty("secret");
  });
});
