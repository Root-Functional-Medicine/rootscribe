import { Factory } from "fishery";
import type { AppConfig, WebhookConfig } from "@rootscribe/shared";
import { DEFAULT_CONFIG } from "@rootscribe/shared";

// Factory for AppConfig. Consolidates the three `makeConfig` clones that
// previously lived in Settings.test.tsx, ReviewStep.test.tsx, and
// JiraStep.test.tsx — each of which hand-spread DEFAULT_CONFIG with
// near-identical tweaks.
//
// The base default mirrors DEFAULT_CONFIG with a test-stable tokenEmail so
// the "signed-in" banner / breadcrumb reads a plausible value. Traits cover
// the three states the setup flow transitions through:
//   - base default: pre-setup (no token, no recordings dir, setupComplete=false)
//   - .authenticated(): Plaud token present but recordings dir not yet chosen
//   - .setupComplete(): every required piece filled in; page renders the
//     "Settings" surface rather than the setup wizard

class AppConfigFactory extends Factory<AppConfig> {
  authenticated(
    token: string = "tok",
    tokenExp: number = Math.floor(Date.parse("2026-07-15T12:00:00Z") / 1000),
  ): this {
    return this.params({
      token,
      tokenExp,
    }) as this;
  }

  setupComplete(recordingsDir: string = "/tmp/rec"): this {
    return this.params({
      setupComplete: true,
      recordingsDir,
      token: "tok",
      tokenExp: Math.floor(Date.parse("2026-07-15T12:00:00Z") / 1000),
    }) as this;
  }

  withRecordingsDir(recordingsDir: string): this {
    return this.params({ recordingsDir }) as this;
  }

  withJiraBaseUrl(jiraBaseUrl: string): this {
    return this.params({ jiraBaseUrl }) as this;
  }

  withWebhook(webhook: WebhookConfig): this {
    return this.params({ webhook }) as this;
  }
}

export const appConfigFactory = AppConfigFactory.define(() => ({
  ...DEFAULT_CONFIG,
  tokenEmail: "alice@example.com",
}));
