export const LogMessages = {
  closingGate: (howMuch: number, when: Date) => `Closing gate for ${howMuch}ms at ${when.toISOString()}`,
  gateIsOpen: () => `Gate is now open at ${new Date().toISOString()}`,
  ignoredSuggestedWait: (howMuch: number, when: Date) =>
    `Suggested wait of ${howMuch}ms from ${when.toISOString()} has already passed at ${new Date().toISOString()}`,
  suggestWait: (howMuch: number, when: Date, reason: "429" | "eoq") =>
    `${reason === "429" ? reason : "End of quota"} detected at ${when.toISOString()}, suggesting wait of ${howMuch}ms`
} as const
