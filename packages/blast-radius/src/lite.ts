// Blast Radius Lite (docs/08 §7): a free, closed-form audit of an agent wallet's spending limits.
// Input is NUMBERS ONLY (or an Agent-Wallet-style policy JSON); no wallet, chain or key is read. Output is a
// report, NOT a Loss Bound Certificate, and says so. Pure: no clock, no I/O; the caller supplies the JSON.
//
// VERIFY(V-07): the policy-JSON field names below are Symbolon's own, modelled on the limit and list kinds
// Circle documents for Agent Wallets (per-tx / daily / weekly / monthly limits, recipient and contract
// allow/blocklists, docs/00 §Circle facts). They are not Circle's schema, and how those limits treat
// `approve`, allowances, contract calls or rolling-vs-calendar windows is exactly what V-07 would have to
// observe. This module therefore (a) computes BOTH window readings and (b) lists those behaviours as questions.
//
// Fail closed: strict objects (an unknown or misspelt key is an error, never a silently unlimited cap); a limit
// of "0" is refused as ambiguous (off, or nothing may leave?); a missing balance is an error; an absent limit
// means NOT SET, and the bound then rests on the balance alone.
import { formatUnits, toBaseUnits } from "@symbolon/chain";
import * as z from "zod";
import { BoundsError, HORIZONS, MAX_UINT256, SECONDS_PER_DAY } from "./bounds";
import { boundWindowed, drainSeconds, maxDetectionWindowed } from "./windowed";
import type { WindowLimit, WindowMode } from "./windowed";

export const LITE_INPUT_SCHEMA = "blast-lite-input/1" as const;
export const LITE_REPORT_SCHEMA = "blast-lite/1" as const;
export const MAX_LITE_INPUT_CHARS = 65_536;
const MAX_LIST_ENTRIES = 10_000;
const MAX_LIST_ENTRY_CHARS = 128;
/** A "monthly" window: the shortest calendar month (28 d) is the conservative reading (more windows per interval). */
export const MONTH_SECONDS = 28n * SECONDS_PER_DAY;
export const WEEK_SECONDS = 7n * SECONDS_PER_DAY;
const LITE_HORIZONS: readonly { label: string; seconds: bigint }[] = [...HORIZONS, { label: "30d", seconds: 30n * SECONDS_PER_DAY }];

// ---------------------------------------------------------------- input -------------------------------------------

export class LiteInputError extends Error {
  readonly issues: readonly { path: string; message: string }[];
  constructor(issues: readonly { path: string; message: string }[]) {
    super(`LITE_INPUT_INVALID: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "LiteInputError";
    this.issues = issues;
  }
}

const amountText = z.string().max(100);
const listOfStrings = z.array(z.string().max(MAX_LIST_ENTRY_CHARS)).max(MAX_LIST_ENTRIES);
const common = {
  schema: z.literal(LITE_INPUT_SCHEMA),
  decimals: z.number().int().min(0).max(36),
  currency: z.string().regex(/^[A-Za-z0-9]{1,12}$/).nullish(),
  balance: amountText,
  humanApprovalThreshold: amountText.nullish(),
  keys: z.number().int().min(1).max(10_000).nullish(),
  roles: z.number().int().min(1).max(10_000).nullish(),
  lossTarget: amountText.nullish(),
};
const NumbersInput = z.strictObject({
  ...common,
  mode: z.literal("numbers"),
  perTxLimit: amountText.nullish(),
  dailyLimit: amountText.nullish(),
  weeklyLimit: amountText.nullish(),
  monthlyLimit: amountText.nullish(),
  recipientAllowlistInUse: z.boolean().nullish(),
  recipientBlocklistInUse: z.boolean().nullish(),
  contractAllowlistInUse: z.boolean().nullish(),
  contractBlocklistInUse: z.boolean().nullish(),
});
const PolicyInput = z.strictObject({
  ...common,
  mode: z.literal("agent-wallet-policy"),
  policy: z.strictObject({
    limits: z
      .strictObject({
        perTransaction: amountText.nullish(),
        daily: amountText.nullish(),
        weekly: amountText.nullish(),
        monthly: amountText.nullish(),
      })
      .nullish(),
    recipients: z.strictObject({ allowlist: listOfStrings.nullish(), blocklist: listOfStrings.nullish() }).nullish(),
    contracts: z.strictObject({ allowlist: listOfStrings.nullish(), blocklist: listOfStrings.nullish() }).nullish(),
  }),
});
const LiteInputSchema = z.discriminatedUnion("mode", [NumbersInput, PolicyInput]);

/** Parsed, validated configuration. Amounts are bigint base units; `null` means not set. */
export interface LiteConfig {
  readonly decimals: number;
  readonly currency: string;
  readonly balance: bigint;
  readonly perTx: bigint | null;
  readonly daily: bigint | null;
  readonly weekly: bigint | null;
  readonly monthly: bigint | null;
  readonly humanApprovalThreshold: bigint | null;
  /** true / false when stated, null when the input did not say. List contents are never kept, only whether used. */
  readonly recipientAllowlistInUse: boolean | null;
  readonly recipientBlocklistInUse: boolean | null;
  readonly contractAllowlistInUse: boolean | null;
  readonly contractBlocklistInUse: boolean | null;
  readonly keys: number | null;
  readonly roles: number | null;
  readonly lossTarget: bigint | null;
}

function amount(text: string | null | undefined, decimals: number, path: string, issues: { path: string; message: string }[], opts: { allowZero: boolean }): bigint | null {
  if (text === null || text === undefined) return null;
  let v: bigint;
  try {
    v = toBaseUnits(text, decimals);
  } catch {
    // Do not echo the value: it is untrusted text. Say what was expected.
    issues.push({ path, message: `not a canonical decimal amount with at most ${decimals} fraction digits (digits and one point, no sign, no exponent, no separators)` });
    return null;
  }
  if (v === 0n && !opts.allowZero) {
    issues.push({ path, message: "0 is ambiguous (limit off, or nothing may leave?). Omit the field or use null for no limit." });
    return null;
  }
  return v;
}

function listInUse(list: readonly string[] | null | undefined): boolean | null {
  return list === null || list === undefined ? null : list.length > 0;
}

/** Validate untrusted JSON (already parsed) into a LiteConfig. Throws LiteInputError listing every problem. */
export function parseLiteInput(input: unknown): LiteConfig {
  const r = LiteInputSchema.safeParse(input);
  if (!r.success) {
    throw new LiteInputError(r.error.issues.map((i) => ({ path: i.path.map(String).join(".") || "$", message: i.message })));
  }
  const d = r.data;
  const issues: { path: string; message: string }[] = [];
  const dec = d.decimals;
  const balance = amount(d.balance, dec, "balance", issues, { allowZero: true });
  const human = amount(d.humanApprovalThreshold, dec, "humanApprovalThreshold", issues, { allowZero: false });
  const lossTarget = amount(d.lossTarget, dec, "lossTarget", issues, { allowZero: true });
  let cfgLimits: { perTx: bigint | null; daily: bigint | null; weekly: bigint | null; monthly: bigint | null };
  let lists: Pick<LiteConfig, "recipientAllowlistInUse" | "recipientBlocklistInUse" | "contractAllowlistInUse" | "contractBlocklistInUse">;
  if (d.mode === "numbers") {
    cfgLimits = {
      perTx: amount(d.perTxLimit, dec, "perTxLimit", issues, { allowZero: false }),
      daily: amount(d.dailyLimit, dec, "dailyLimit", issues, { allowZero: false }),
      weekly: amount(d.weeklyLimit, dec, "weeklyLimit", issues, { allowZero: false }),
      monthly: amount(d.monthlyLimit, dec, "monthlyLimit", issues, { allowZero: false }),
    };
    lists = {
      recipientAllowlistInUse: d.recipientAllowlistInUse ?? null,
      recipientBlocklistInUse: d.recipientBlocklistInUse ?? null,
      contractAllowlistInUse: d.contractAllowlistInUse ?? null,
      contractBlocklistInUse: d.contractBlocklistInUse ?? null,
    };
  } else {
    const l = d.policy.limits ?? {};
    cfgLimits = {
      perTx: amount(l.perTransaction, dec, "policy.limits.perTransaction", issues, { allowZero: false }),
      daily: amount(l.daily, dec, "policy.limits.daily", issues, { allowZero: false }),
      weekly: amount(l.weekly, dec, "policy.limits.weekly", issues, { allowZero: false }),
      monthly: amount(l.monthly, dec, "policy.limits.monthly", issues, { allowZero: false }),
    };
    lists = {
      recipientAllowlistInUse: listInUse(d.policy.recipients?.allowlist),
      recipientBlocklistInUse: listInUse(d.policy.recipients?.blocklist),
      contractAllowlistInUse: listInUse(d.policy.contracts?.allowlist),
      contractBlocklistInUse: listInUse(d.policy.contracts?.blocklist),
    };
  }
  if (issues.length > 0 || balance === null) {
    throw new LiteInputError(issues.length > 0 ? issues : [{ path: "balance", message: "required" }]);
  }
  return Object.freeze({
    decimals: dec,
    currency: d.currency ?? "units",
    balance,
    ...cfgLimits,
    humanApprovalThreshold: human,
    ...lists,
    keys: d.keys ?? null,
    roles: d.roles ?? null,
    lossTarget,
  });
}

// --------------------------------------------------------------- output -------------------------------------------

export interface Money {
  /** Decimal string of base units (exact). */
  readonly baseUnits: string;
  /** Exact decimal rendering at the declared decimals. */
  readonly formatted: string;
}
export interface HorizonReport {
  readonly label: string;
  readonly seconds: string;
  readonly value: Money;
  readonly binding: readonly string[];
}
export interface InterpretationReport {
  readonly mode: WindowMode;
  readonly horizons: readonly HorizonReport[];
  /** Fewest seconds in which the whole balance can leave ("0" when the balance is 0). */
  readonly drainSeconds: string;
  readonly drainText: string;
  readonly detection: {
    readonly lossTarget: Money;
    readonly lossTargetSource: "supplied" | "default: 10 % of balance";
    /** Seconds as a decimal string, or UNBOUNDED_BELOW_TARGET. */
    readonly maxSeconds: string;
    readonly text: string;
  };
}
export type FindingSeverity = "HIGH" | "MEDIUM" | "INFO";
export interface Finding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly text: string;
}
export interface LiteReport {
  readonly schema: typeof LITE_REPORT_SCHEMA;
  readonly kind: "LITE_ESTIMATE";
  readonly notACertificate: string;
  readonly headline: string;
  readonly decimals: number;
  readonly currency: string;
  readonly inputs: {
    readonly balance: Money;
    readonly perTxLimit: Money | null;
    readonly dailyLimit: Money | null;
    readonly weeklyLimit: Money | null;
    readonly monthlyLimit: Money | null;
    readonly humanApprovalThreshold: Money | null;
    readonly recipientAllowlistInUse: boolean | null;
    readonly recipientBlocklistInUse: boolean | null;
    readonly contractAllowlistInUse: boolean | null;
    readonly contractBlocklistInUse: boolean | null;
    readonly keys: number | null;
    readonly roles: number | null;
  };
  readonly interpretations: { readonly rolling: InterpretationReport; readonly calendar: InterpretationReport };
  /** The calendar-bucket reading at 24 h versus the rolling reading (docs/08 §7: the 2x boundary effect). */
  readonly boundaryEffect: { readonly rolling24h: Money; readonly calendar24h: Money; readonly extra: Money; readonly present: boolean };
  readonly findings: readonly Finding[];
  readonly questions: readonly string[];
  readonly assumptions: readonly { readonly id: string; readonly text: string }[];
  readonly exclusions: readonly { readonly id: string; readonly text: string }[];
  readonly notes: readonly string[];
}

export const LITE_ASSUMPTIONS: readonly { id: string; text: string }[] = Object.freeze([
  { id: "A-POLICY-KEY", text: "Whoever can instruct payments (a compromised agent or key) cannot change the limits. If they can, the bound is the whole balance." },
  { id: "A-COUNTED", text: "Every outgoing value transfer counts against the limits you supplied. Approvals, allowances, contract calls and transfers to sibling wallets are not modelled (see the questions)." },
  { id: "A-NUMBERS", text: "The numbers you supplied describe the live configuration. Nothing was read from any wallet, chain or service." },
  { id: "A-WINDOWS", text: "Both window readings are shown (rolling and calendar buckets, worst-case alignment); the larger one is the safe one to plan on. A monthly window is taken as 28 days, the shortest calendar month." },
  { id: "A-CHAIN", text: "The chain is live and final, and the token behaves as an honest ERC-20 (no issuer freeze, upgrade or depeg event)." },
]);
export const LITE_EXCLUSIONS: readonly { id: string; text: string }[] = Object.freeze([
  { id: "X-POLICY-KEY", text: "Compromise of the key or role that can change the policy: the loss is then the whole balance." },
  { id: "X-UNCOUNTED-FLOWS", text: "Value that does not count against the limits on your platform (allowances, contract calls, sibling wallets, other chains): unknown until you answer the questions." },
  { id: "X-PLATFORM", text: "Bugs or behaviour of the wallet platform that differ from the numbers you supplied." },
  { id: "X-TOKEN-CHAIN", text: "Issuer actions on the token, depeg, chain halt or deep reorg, and RPC dishonesty." },
  { id: "X-AVAILABILITY", text: "Availability: a compromised key can also exhaust limits to block legitimate payments." },
  { id: "X-QUALITY", text: "Whether the work being paid for was good. Limits bound who is paid, how much and how fast, not quality." },
]);

const NOT_A_CERTIFICATE =
  "This is a Blast Radius Lite estimate calculated from the numbers you supplied. No chain state was read, nothing here is a Loss Bound Certificate, and it has not been empirically tested against your platform.";

function money(v: bigint, decimals: number): Money {
  if (v < 0n || v > MAX_UINT256) throw new BoundsError("INVALID_INPUT", "amount out of range");
  return Object.freeze({ baseUnits: v.toString(), formatted: formatUnits(v, decimals) });
}

/** "4 d 0 h 0 min 1 s". bigint arithmetic only. */
export function durationText(seconds: bigint): string {
  if (seconds < 0n) throw new BoundsError("INVALID_HORIZON", "negative duration");
  const d = seconds / 86_400n;
  const h = (seconds % 86_400n) / 3600n;
  const m = (seconds % 3600n) / 60n;
  const s = seconds % 60n;
  const parts: string[] = [];
  if (d > 0n) parts.push(`${d} d`);
  if (h > 0n) parts.push(`${h} h`);
  if (m > 0n) parts.push(`${m} min`);
  if (s > 0n || parts.length === 0) parts.push(`${s} s`);
  return parts.join(" ");
}

function limitsOf(c: LiteConfig): WindowLimit[] {
  const out: WindowLimit[] = [];
  if (c.daily !== null) out.push({ label: "daily limit", lengthSeconds: SECONDS_PER_DAY, cap: c.daily });
  if (c.weekly !== null) out.push({ label: "weekly limit", lengthSeconds: WEEK_SECONDS, cap: c.weekly });
  if (c.monthly !== null) out.push({ label: "monthly limit", lengthSeconds: MONTH_SECONDS, cap: c.monthly });
  return out;
}

function interpret(c: LiteConfig, mode: WindowMode, limits: readonly WindowLimit[], target: bigint, targetSource: InterpretationReport["detection"]["lossTargetSource"]): InterpretationReport {
  const horizons = LITE_HORIZONS.map((h) => {
    const b = boundWindowed(c.balance, limits, mode, h.seconds);
    return Object.freeze({ label: h.label, seconds: h.seconds.toString(), value: money(b.value, c.decimals), binding: b.binding });
  });
  const drain = drainSeconds(c.balance, limits, mode);
  const det = maxDetectionWindowed(c.balance, limits, mode, target);
  const detText =
    det === "UNBOUNDED_BELOW_TARGET"
      ? `Your whole balance is at or under the loss target, so no detection time is needed to stay within it.`
      : det === 0n
        ? `Even one second of spending can exceed the loss target: no detection delay keeps the loss within it.`
        : `To keep the loss at or under ${formatUnits(target, c.decimals)} ${c.currency}, spending must be detected and stopped within ${durationText(det)}.`;
  return Object.freeze({
    mode,
    horizons: Object.freeze(horizons),
    drainSeconds: drain.toString(),
    drainText: c.balance === 0n ? "The balance is 0." : `The whole balance can leave in as little as ${durationText(drain)}.`,
    detection: Object.freeze({
      lossTarget: money(target, c.decimals),
      lossTargetSource: targetSource,
      maxSeconds: det === "UNBOUNDED_BELOW_TARGET" ? det : det.toString(),
      text: detText,
    }),
  });
}

function redundancyFindings(c: LiteConfig): Finding[] {
  const out: Finding[] = [];
  const pairs: [string, bigint | null, string, bigint | null, bigint][] = [
    ["daily", c.daily, "weekly", c.weekly, 7n],
    ["weekly", c.weekly, "monthly", c.monthly, 4n],
    ["daily", c.daily, "monthly", c.monthly, 28n],
  ];
  for (const [shortName, shortCap, longName, longCap, ratio] of pairs) {
    if (shortCap === null || longCap === null) continue;
    if (longCap < shortCap) {
      out.push({ id: `LIMIT_ORDER_${longName.toUpperCase()}_BELOW_${shortName.toUpperCase()}`, severity: "INFO", text: `The ${longName} limit is below the ${shortName} limit, so the ${shortName} limit can never be used in full.` });
    } else if (longCap >= shortCap * ratio) {
      out.push({ id: `LIMIT_REDUNDANT_${longName.toUpperCase()}`, severity: "INFO", text: `The ${longName} limit is at least ${ratio} times the ${shortName} limit, so it never binds on its own.` });
    }
  }
  return out;
}

/** Compute the report for a validated configuration. Pure; throws BoundsError on out-of-range values. */
export function computeLite(c: LiteConfig): LiteReport {
  const limits = limitsOf(c);
  const defaultTarget = c.balance / 10n;
  const target = c.lossTarget ?? defaultTarget;
  const source = c.lossTarget === null ? ("default: 10 % of balance" as const) : ("supplied" as const);
  const rolling = interpret(c, "rolling", limits, target, source);
  const calendar = interpret(c, "calendar", limits, target, source);

  const day = SECONDS_PER_DAY;
  const r24 = boundWindowed(c.balance, limits, "rolling", day).value;
  const c24 = boundWindowed(c.balance, limits, "calendar", day).value;
  const boundaryEffect = Object.freeze({ rolling24h: money(r24, c.decimals), calendar24h: money(c24, c.decimals), extra: money(c24 - r24, c.decimals), present: c24 > r24 });

  const findings: Finding[] = [];
  if (limits.length === 0) {
    findings.push({ id: "NO_PERIOD_LIMIT", severity: "HIGH", text: "No daily, weekly or monthly limit was supplied, so nothing stops the whole balance leaving in one burst." });
  }
  if (c.perTx !== null) {
    findings.push({
      id: "PER_TX_NOT_A_VOLUME_BOUND",
      severity: "INFO",
      text: `A per-transaction limit (${formatUnits(c.perTx, c.decimals)} ${c.currency}) caps one transfer, not the total. With no limit on the number of transfers, it only slows the drain down to as many transfers as it takes.`,
    });
  }
  if (limits.length > 0 && boundaryEffect.present) {
    findings.push({
      id: "CALENDAR_BOUNDARY_EFFECT",
      severity: "MEDIUM",
      text: `If your limits reset on calendar boundaries, up to ${boundaryEffect.calendar24h.formatted} ${c.currency} can leave within 24 h across one reset, against ${boundaryEffect.rolling24h.formatted} ${c.currency} for a rolling window.`,
    });
  }
  const drainR = BigInt(rolling.drainSeconds);
  if (c.balance > 0n && drainR <= day) {
    findings.push({ id: "BALANCE_REACHABLE_WITHIN_A_DAY", severity: "HIGH", text: `The whole balance can leave within 24 h (as little as ${durationText(drainR)}).` });
  }
  findings.push(...redundancyFindings(c));
  if (c.humanApprovalThreshold === null) {
    findings.push({ id: "NO_HUMAN_APPROVAL_THRESHOLD", severity: "INFO", text: "No human-approval threshold was supplied: no amount waits for a person." });
  }
  if (c.recipientAllowlistInUse !== true) {
    findings.push({ id: "NO_RECIPIENT_ALLOWLIST", severity: "MEDIUM", text: c.recipientAllowlistInUse === false ? "No recipient allowlist is in use: any address can be paid within the limits." : "It was not stated whether a recipient allowlist is in use; assume any address can be paid within the limits." });
  }

  const questions: string[] = [
    "Do approvals and allowances (for example an ERC-20 approve) and contract calls count against the limits?",
    "Can funds be moved to a sibling wallet or another chain, and do those wallets share the same limits?",
    "Who holds the key or role that can change the policy, and what does a change require?",
    "Are the limits rolling windows or calendar buckets (resetting at midnight UTC, or on the 1st of the month)?",
    "Who is alerted when spending approaches a limit, and how quickly can the wallet be frozen?",
  ];
  if (c.recipientAllowlistInUse === true) questions.push("Who can edit the recipient allowlist, and does an edit take effect immediately?");
  if ((c.keys ?? 1) > 1 || (c.roles ?? 1) > 1) {
    questions.push(`${c.keys ?? "Several"} key(s) and ${c.roles ?? "several"} role(s) were stated: is every one of them subject to the same limits, or does each have its own?`);
  }

  const headline =
    limits.length === 0
      ? `If whoever can instruct payments from this wallet is compromised, the whole balance (${money(c.balance, c.decimals).formatted} ${c.currency}) can leave at once; no period limit was supplied. Calculated from the numbers supplied; assumptions and exclusions below.`
      : `If whoever can instruct payments from this wallet is compromised, at most ${money(r24, c.decimals).formatted} ${c.currency} can leave in the first 24 h under a rolling window (${money(c24, c.decimals).formatted} ${c.currency} if the limits reset on calendar boundaries). Calculated from the numbers supplied; assumptions and exclusions below.`;

  const opt = (v: bigint | null): Money | null => (v === null ? null : money(v, c.decimals));
  return Object.freeze({
    schema: LITE_REPORT_SCHEMA,
    kind: "LITE_ESTIMATE",
    notACertificate: NOT_A_CERTIFICATE,
    headline,
    decimals: c.decimals,
    currency: c.currency,
    inputs: Object.freeze({
      balance: money(c.balance, c.decimals),
      perTxLimit: opt(c.perTx),
      dailyLimit: opt(c.daily),
      weeklyLimit: opt(c.weekly),
      monthlyLimit: opt(c.monthly),
      humanApprovalThreshold: opt(c.humanApprovalThreshold),
      recipientAllowlistInUse: c.recipientAllowlistInUse,
      recipientBlocklistInUse: c.recipientBlocklistInUse,
      contractAllowlistInUse: c.contractAllowlistInUse,
      contractBlocklistInUse: c.contractBlocklistInUse,
      keys: c.keys,
      roles: c.roles,
    }),
    interpretations: Object.freeze({ rolling, calendar }),
    boundaryEffect,
    findings: Object.freeze(findings.map((f) => Object.freeze(f))),
    questions: Object.freeze(questions),
    assumptions: LITE_ASSUMPTIONS,
    exclusions: LITE_EXCLUSIONS,
    notes: Object.freeze([
      "Exclusions are listed above the figures in any display of this report (RT-21).",
      "The window readings differ only in how a period is counted; the figures are upper bounds for the stated model, not predictions.",
    ]),
  });
}

/** Parse + compute from already-parsed JSON. */
export function auditLite(input: unknown): LiteReport {
  return computeLite(parseLiteInput(input));
}

/** The thin entry point for an API route or CLI: untrusted JSON text in, report out. Size-capped, strict. */
export function auditLiteFromJson(text: string): LiteReport {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_LITE_INPUT_CHARS) {
    throw new LiteInputError([{ path: "$", message: `input must be a JSON text of 1..${MAX_LITE_INPUT_CHARS} characters` }]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LiteInputError([{ path: "$", message: "not valid JSON" }]);
  }
  return auditLite(parsed);
}
