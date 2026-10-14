// docs/04 section 7 policy example with the three caps parameterised (the rest is the spec text).
export const policyText = (perTx: string, daily: string, human: string): string => `version: 1
tenant: edith-studio
currency: { code: USDC, decimals: 6, treatUsdAsUsdc: true }
caps:
  perTxHardCap: "${perTx}"
  dailyCap: "${daily}"
  weeklyCap: "1400.000000"
  humanApprovalAbove: "${human}"
velocity: { maxReleasesPerDay: 10, maxReleasesPerPayeePerDay: 3, maxAmountPerPayeePerDay: "150.000000" }
newPayee: { firstPaymentMax: "25.000000", alwaysHuman: true }
categories: { design: "150.000000", dev: "300.000000", tools: "100.000000" }
reserve: { floor: "10.000000", lookaheadDays: 14 }
timing: { disputeWindowHours: 0, payBeforeDueBufferHours: 24, allowImmediate: true, defaultNetDays: 30, windowSafetyMarginMinutes: 60 }
treasury: { costOfCapitalBps: 0 }
escalation: { maxPerDay: 8, maxPerEngagementPerDay: 3 }
limits: { maxDocChars: 20000 }
evidence: { freshnessHours: 72, allowOwnerOverride: true, urlAllowlist: ["https://*.vercel.app"] }
extraction: { allowSingle: false }
screening: { required: false, staleAfterHours: 24 }
reconciliation: { ackWindowHours: 72 }
`;
