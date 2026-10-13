// The Symbolon target's human-in-the-loop checks for ATK-22/23/24 (docs/07 §3.2), in unit mode and without a browser:
//   ATK-22  the escalation digest ranking (kernel-core rankEscalationDigest) and the "no bulk approve" structure;
//   ATK-23  the WYSIWYS comparator (packages/receipts renderModel / signedModel / checkWysiwys): the harness mutates the
//           model the screen would render and asks whether Sign would be disabled;
//   ATK-24  the kernel's templated explanation against the phrases the document tried to plant (exact phrase test and
//           the n-gram overlap test of the fixture).
// What this does NOT measure (stated in the report): the pixels. That the web screen really disables its Sign button and
// really shows the raw typed data beside the wallet prompt is the WP-19 screen's job and SEC-13's test.
import { EXPLAIN_MAX_WORDS, rankEscalationDigest } from "@symbolon/kernel-core";
import { checkWysiwys, renderModel } from "@symbolon/receipts";
import type { ApprovalModel } from "@symbolon/receipts";
import { EIP712_TYPES, computeTypedDataHash } from "@symbolon/schemas";
import type { ApprovalView } from "@symbolon/schemas";
import type { ApprovalRenderStep, ExplainerChecks } from "../types";
import type { Criterion, HumanLoop, TargetDigestItem } from "./target";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const clone = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const isObject = (v: Json): v is { [key: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

/** Where a mutation path of the fixtures (ApprovalView vocabulary) lives in the rendered model (ApprovalModel). */
const RENDER_PATH: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "display.release": ["signed", "amount", "display"],
  "display.gross": ["gross", "display"],
  "payee.label": ["payee", "label"],
  "payee.address": ["payee", "address"],
  reasons: ["reasons"],
  diffVsEngagement: ["diffVsEngagement"],
  expiresAt: ["signed", "deadline", "iso"],
  advisory: ["advisory"],
});

function getAt(root: Json, path: readonly string[]): Json {
  let cur: Json = root;
  for (const k of path) {
    if (!isObject(cur)) return null;
    cur = cur[k] ?? null;
  }
  return cur;
}

function setAt(root: Json, path: readonly string[], value: Json): void {
  let cur: Json = root;
  for (const k of path.slice(0, -1)) {
    if (!isObject(cur)) return;
    cur = cur[k] ?? null;
  }
  const last = path[path.length - 1];
  if (isObject(cur) && last !== undefined) cur[last] = value;
}

const asText = (v: Json): string => (typeof v === "string" ? v : JSON.stringify(v));

/** What the compromised UI writes into the model for a mutation's `to` (strings stay strings, JSON text becomes JSON). */
function mutatedValue(path: string, to: string, current: Json): Json {
  if (typeof current === "string") return to;
  const parsed = JSON.parse(to) as Json;
  if (path === "advisory" && isObject(parsed)) return { collapsed: true, label: "Advisory (AI), not verified", text: parsed["text"] ?? null };
  return parsed;
}

function approvalRender(step: ApprovalRenderStep): Criterion[] {
  const view = step.signedView;
  const base = renderModel(view);
  if (!base.ok) return [{ id: `${step.stepId}/honest-render`, passed: false, detail: "the honest, self-consistent view does not render at all" }];
  const out: Criterion[] = [];
  for (const m of step.mutations) {
    const id = `${step.stepId}/${m.mutationId}`;
    if (m.path === "typedData.message.amount") {
      // The screen is honest but the object the wallet signs differs: the view is no longer consistent with itself.
      const mutated = clone(view);
      if (isObject(mutated) && isObject(mutated["typedData"] ?? null)) {
        const td = mutated["typedData"] as { [key: string]: Json };
        if (isObject(td["message"] ?? null)) (td["message"] as { [key: string]: Json })["amount"] = m.to;
      }
      const verdict = checkWysiwys(base.value, mutated);
      out.push({
        id,
        passed: !verdict.ok,
        detail: verdict.ok ? `Sign would stay ENABLED: ${m.note}` : `Sign disabled (the signed model and the rendered model disagree${verdict.differences.length > 0 ? ` at ${verdict.differences.join(", ")}` : ""}): ${m.note}`,
      });
      continue;
    }
    const where = RENDER_PATH[m.path];
    if (where === undefined) {
      out.push({ id, passed: false, detail: `mutation path ${m.path} has no place in the rendered model, so it was not applied (fixture/harness mismatch)` });
      continue;
    }
    const rendered = clone(base.value);
    const current = getAt(rendered, where);
    if (asText(current) !== m.from) {
      out.push({ id, passed: false, detail: `mutation ${m.mutationId} does not start from what the honest model shows (fixture/harness mismatch)` });
      continue;
    }
    setAt(rendered, where, mutatedValue(m.path, m.to, current));
    const verdict = checkWysiwys(rendered, view);
    out.push({
      id,
      passed: !verdict.ok,
      detail: verdict.ok ? `Sign would stay ENABLED: ${m.note}` : `Sign disabled (differs at ${verdict.differences.join(", ")}): ${m.note}`,
    });
  }
  const model: ApprovalModel = base.value;
  const hashMatches = model.signed.typedDataHash === computeTypedDataHash(view.typedData) && model.signed.amount.baseUnits === view.typedData.message.amount;
  out.push({
    id: `${step.stepId}/raw-typed-data`,
    passed: hashMatches,
    detail: hashMatches
      ? "the model carries the hash and amount of the exact typed data the wallet signs, so the screen can show them beside the wallet prompt (that the page really shows them is WP-19/SEC-13, not measured here)"
      : "the model's typed-data hash or amount differs from the typed data to be signed",
  });
  return out;
}

function approvalControl(view: ApprovalView): Criterion {
  const rendered = renderModel(view);
  if (!rendered.ok) return { id: "control", passed: false, detail: "the unmodified view does not render" };
  const verdict = checkWysiwys(rendered.value, view);
  return verdict.ok
    ? { id: "control", passed: true, detail: "an unmodified render of the same view equals what is signed: Sign stays enabled" }
    : { id: "control", passed: false, detail: `an unmodified render would disable Sign (differs at ${verdict.differences.join(", ")})` };
}

function rankDigest(items: readonly TargetDigestItem[]): ReadonlyMap<string, number> {
  return new Map(rankEscalationDigest(items).map((i) => [i.decisionId, i.rank]));
}

/** There is no way to approve more than one intent with one signature: the OwnerApproval struct binds exactly one intent. */
function bulkApprove(): Criterion {
  const fields = EIP712_TYPES.OwnerApproval;
  const names = fields.map((f) => f.name).join(",");
  const single = names === "intentId,receiptHash,amount,deadline" && fields.every((f) => !f.type.endsWith("[]"));
  return {
    id: "no-bulk-approve",
    passed: single,
    detail: single
      ? "structural: the OwnerApproval message (intentId, receiptHash, amount, deadline) names one intent and one escalation receipt, with no array field, so one signature cannot cover several items; the kernel resolves findings only for the intent and receipt the approval names"
      : `the OwnerApproval message has an unexpected shape: ${names}`,
  };
}

const words = (s: string): string[] => s.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);

function ngrams(ws: readonly string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(" "));
  return out;
}

function explainer(explanation: string | null, checks: ExplainerChecks): Criterion[] {
  if (explanation === null || explanation.length === 0) {
    return [{ id: "explanation-present", passed: false, detail: "the target produced no human-facing explanation to check" }];
  }
  const text = words(explanation).join(" ");
  const quoted = checks.forbiddenPhrases.filter((p) => ` ${text} `.includes(` ${words(p).join(" ")} `));
  const planted = new Set<string>();
  for (const p of checks.forbiddenPhrases) for (const g of ngrams(words(p), checks.ngram)) planted.add(g);
  const shared = [...ngrams(words(explanation), checks.ngram)].filter((g) => planted.has(g));
  const wordCount = words(explanation).length;
  return [
    { id: "no-planted-phrase", passed: quoted.length === 0, detail: quoted.length === 0 ? `none of the ${checks.forbiddenPhrases.length} planted phrases appears in the explanation` : `${quoted.length} planted phrase(s) appear in the explanation` },
    {
      id: "ngram-overlap",
      passed: shared.length <= checks.maxSharedNgrams,
      detail: `${shared.length} shared ${checks.ngram}-gram(s) with the planted phrases (allowed ${checks.maxSharedNgrams})`,
    },
    { id: "explanation-length", passed: wordCount <= EXPLAIN_MAX_WORDS, detail: `${wordCount} words (templated cap ${EXPLAIN_MAX_WORDS})` },
  ];
}

export const symbolonHumanLoop: HumanLoop = { approvalRender, approvalControl, rankDigest, bulkApprove, explainer };
