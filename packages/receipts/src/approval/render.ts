// The approval screen's view-model and the WYSIWYS comparator (INV-20, RT-13, ATK-23, SEC-13).
//
//   renderModel(view)   the model the UI renders. Its `signed` section is built from the view's DISPLAY fields
//                       (display.release, expiresAt, intentId, ...): what the owner reads.
//   signedModel(view)   the same model, but its `signed` section is built from `view.typedData`, the object the
//                       wallet is asked to sign: what the owner commits to.
//   checkWysiwys(rendered, view)
//                       jcs(rendered) must equal jcs(signedModel(view)). A UI that computes this before enabling
//                       "Sign" cannot be made to show "$50" while the wallet signs "$500" (ATK-23): the harness
//                       mutates the rendered model and this reports exactly which paths differ.
//
// Both builders first parse the view with the frozen ApprovalViewSchema, so a view whose typed data, display
// strings, hash or expiry disagree with its own fields produces no model at all (fail closed). The model holds data,
// not copy: reason CODES, not sentences; labels come from the signed engagement; the only free text in it is
// `diffVsEngagement[].actual` and `advisory.text`, both typed Untrusted<string> and to be rendered ONLY through
// <UntrustedText>. The advisory (AI) note is a separate, collapsed field: it is never part of `signed`, and the UI must
// not place it next to the Approve button (INV-20).
import {
  ApprovalViewSchema,
  computeTypedDataHash,
  epochSecondsFromIso,
  formatBaseUnits,
  isoFromEpochSeconds,
  jcs,
  type Address,
  type ApprovalView,
  type Eip712Domain,
  type Hex32,
  type ISODateTime,
  type ReasonCode,
  type Untrusted,
} from "@symbolon/schemas";
import { attempt, describeIssues, err, ok, type Result } from "../result";

/** The label the UI must show on the collapsed AI note (docs/05 ApprovalView.advisory). */
export const ADVISORY_LABEL = "Advisory (AI), not verified" as const;

/** What the wallet signature commits to, in display form. */
export interface SignedSection {
  readonly primaryType: "OwnerApproval";
  readonly domain: Eip712Domain;
  readonly intentId: Hex32;
  /** The ESCALATION receipt the owner reviewed. */
  readonly receiptHash: Hex32;
  readonly amount: { readonly baseUnits: string; readonly decimals: number; readonly display: string };
  readonly deadline: { readonly epochSeconds: string; readonly iso: ISODateTime };
  /** keccak256(JCS(typedData)), shown beside the wallet prompt. */
  readonly typedDataHash: Hex32;
}

export interface ApprovalModel {
  readonly kind: "OWNER_APPROVAL";
  readonly signed: SignedSection;
  readonly payee: { readonly address: Address; readonly label: string };
  readonly engagementId: Hex32;
  readonly milestoneId: Hex32;
  readonly gross: { readonly baseUnits: string; readonly display: string };
  readonly diffVsEngagement: ReadonlyArray<{ readonly field: string; readonly expected: string; readonly actual: Untrusted<string> }>;
  readonly reasons: readonly ReasonCode[];
  readonly planSummary: ApprovalView["planSummary"];
  /** Collapsed, labelled, advisory only; never adjacent to the Approve action. */
  readonly advisory: { readonly collapsed: true; readonly label: typeof ADVISORY_LABEL; readonly text: Untrusted<string> } | null;
}

function parseView(view: unknown): Result<ApprovalView> {
  const parsed = ApprovalViewSchema.safeParse(view);
  return parsed.success ? ok(parsed.data) : err("APPROVAL_INVALID", `not a consistent ApprovalView: ${describeIssues(parsed.error.issues)}`);
}

function assemble(v: ApprovalView, signed: SignedSection, grossDisplay: string): ApprovalModel {
  return {
    kind: "OWNER_APPROVAL",
    signed,
    payee: { address: v.payee.address, label: v.payee.label },
    engagementId: v.engagementId,
    milestoneId: v.milestoneId,
    gross: { baseUnits: v.grossBaseUnits, display: grossDisplay },
    diffVsEngagement: v.diffVsEngagement.map((d) => ({ field: d.field, expected: d.expected, actual: d.actual })),
    reasons: [...v.reasons],
    planSummary: v.planSummary,
    advisory: v.advisory === null ? null : { collapsed: true, label: ADVISORY_LABEL, text: v.advisory.text },
  };
}

/** The model the UI renders, from the view's display fields. */
export function renderModel(view: unknown): Result<ApprovalModel> {
  return attempt(
    () => {
      const parsed = parseView(view);
      if (!parsed.ok) return parsed;
      const v = parsed.value;
      return ok(
        assemble(
          v,
          {
            primaryType: "OwnerApproval",
            domain: v.typedData.domain,
            intentId: v.intentId,
            receiptHash: v.receiptHash,
            amount: { baseUnits: v.releaseBaseUnits, decimals: v.decimals, display: v.display.release },
            deadline: { epochSeconds: epochSecondsFromIso(v.expiresAt).toString(), iso: v.expiresAt },
            typedDataHash: v.typedDataHash,
          },
          v.display.gross,
        ),
      );
    },
    "APPROVAL_INVALID",
    "cannot render the approval model",
  );
}

/** The same model with its `signed` section taken from the typed data the wallet will sign. */
export function signedModel(view: unknown): Result<ApprovalModel> {
  return attempt(
    () => {
      const parsed = parseView(view);
      if (!parsed.ok) return parsed;
      const v = parsed.value;
      const m = v.typedData.message;
      return ok(
        assemble(
          v,
          {
            primaryType: v.typedData.primaryType,
            domain: v.typedData.domain,
            intentId: m.intentId,
            receiptHash: m.receiptHash,
            amount: { baseUnits: m.amount, decimals: v.decimals, display: formatBaseUnits(m.amount, v.decimals) },
            deadline: { epochSeconds: m.deadline, iso: isoFromEpochSeconds(BigInt(m.deadline)) },
            typedDataHash: computeTypedDataHash(v.typedData),
          },
          formatBaseUnits(v.grossBaseUnits, v.decimals),
        ),
      );
    },
    "APPROVAL_INVALID",
    "cannot derive the signed model",
  );
}

export interface WysiwysOptions {
  /** The vault/chain the app is actually deployed against; a view naming another domain is refused. */
  readonly expectedDomain?: Eip712Domain;
}

export type WysiwysResult = { readonly ok: true } | { readonly ok: false; readonly differences: readonly string[] };

const MAX_DIFFERENCES = 16;

function collectDifferences(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length >= MAX_DIFFERENCES) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) collectDifferences(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) collectDifferences(a[k], b[k], `${path}.${k}`, out);
    return;
  }
  if (jcsOrUndefined(a) !== jcsOrUndefined(b)) out.push(path);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jcsOrUndefined(v: unknown): string | undefined {
  return v === undefined ? undefined : jcs(v);
}

/**
 * Does what the UI renders equal what the wallet will sign? `rendered` is the model object the page displays
 * (untrusted until compared). Never throws; `differences` are JSON paths (never values) so they are safe to show.
 */
export function checkWysiwys(rendered: unknown, view: unknown, options: WysiwysOptions = {}): WysiwysResult {
  const expected = signedModel(view);
  if (!expected.ok) return { ok: false, differences: ["view"] };
  let renderedJson: string;
  try {
    renderedJson = jcs(rendered);
  } catch {
    return { ok: false, differences: ["rendered"] };
  }
  const differences: string[] = [];
  if (options.expectedDomain !== undefined && jcs(options.expectedDomain) !== jcs(expected.value.signed.domain)) {
    differences.push("signed.domain (not the expected vault/chain)");
  }
  if (renderedJson !== jcs(expected.value)) {
    collectDifferences(JSON.parse(renderedJson) as unknown, JSON.parse(jcs(expected.value)) as unknown, "$", differences);
  }
  return differences.length === 0 ? { ok: true } : { ok: false, differences };
}
