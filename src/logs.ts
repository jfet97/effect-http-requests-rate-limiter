import { Duration } from "effect"

export const LogMessages = {
  closingGate: (howMuch: Duration.Duration, when: Date) =>
    `🚪 Closing rate limiter gate - waiting ${Duration.toMillis(howMuch)}ms until ${when.toISOString()}`,
  gateIsOpen: () => `🟢 Rate limiter gate reopened at ${new Date().toISOString()} - requests can proceed`,
  ignoredSuggestedWait: (howMuch: Duration.Duration, when: Date) =>
    `⏭️  Skipping wait - ${Duration.toMillis(howMuch)}ms delay from ${when.toISOString()} already elapsed at ${
      new Date().toISOString()
    }`,
  suggestWait: (howMuch: Duration.Duration, when: Date, reason: "429" | "end_of_quota") =>
    `🚫 ${
      reason === "429" ? "Rate limit exceeded (429)" : "Request quota exhausted"
    } at ${when.toISOString()} - scheduling ${Duration.toMillis(howMuch)}ms delay`
} as const
