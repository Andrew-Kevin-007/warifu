// Public data access: live kernel first, RECORDED bundle second, explicit "unavailable" last (DEC-016, INV-21).
// Everything returned here is already validated against the frozen schemas, so pages render it without re-checking.
import { LossBoundCertificateSchema, SignedReceiptSchema } from "@symbolon/schemas";
import type { LossBoundCertificate, SignedReceipt } from "@symbolon/schemas";
import { certificateView } from "@symbolon/blast-radius/lbc";
import type { CertificateView } from "@symbolon/blast-radius/lbc";
import { kernelCall } from "./kernel-client";
import { loadBundle } from "./recorded";

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const isHex32 = (s: string): boolean => HEX32.test(s);
export const isAddress = (s: string): boolean => ADDRESS.test(s);

export type Sourced<T> = { source: "LIVE" | "RECORDED"; data: T } | { source: "UNAVAILABLE"; reason: string };

export interface CertificateResult {
  readonly certificate: LossBoundCertificate;
  readonly view: CertificateView;
  readonly verification: { readonly outcome: string; readonly exitCode?: number } | null;
}

export async function getCertificate(vault: string): Promise<Sourced<CertificateResult>> {
  if (!isAddress(vault)) return { source: "UNAVAILABLE", reason: "not a vault address" };
  const live = await kernelCall<{ certificate: unknown; verification?: { outcome: string; exitCode?: number; diffs?: unknown[] } }>(`/v1/certificates/${vault}`);
  if (live.ok) {
    const parsed = LossBoundCertificateSchema.safeParse(live.data.certificate);
    if (parsed.success) {
      const v = live.data.verification;
      // The view is recomputed here from the parsed certificate, not taken from the server's pre-rendered one.
      const view = certificateView(parsed.data, v === undefined ? undefined : ({ outcome: v.outcome, diffs: v.diffs ?? [] } as never));
      return { source: "LIVE", data: { certificate: parsed.data, view, verification: v ?? null } };
    }
  }
  const rec = loadBundle()?.certificate;
  if (rec !== null && rec !== undefined) {
    const parsed = LossBoundCertificateSchema.safeParse(rec);
    if (parsed.success && parsed.data.subject.vault.toLowerCase() === vault.toLowerCase()) {
      return { source: "RECORDED", data: { certificate: parsed.data, view: certificateView(parsed.data), verification: null } };
    }
  }
  return { source: "UNAVAILABLE", reason: "no certificate for this vault is available live or in the recorded bundle" };
}

export interface ReceiptResult {
  readonly signed: SignedReceipt;
  readonly tx: unknown;
}

export async function getReceipt(hash: string): Promise<Sourced<ReceiptResult>> {
  if (!isHex32(hash)) return { source: "UNAVAILABLE", reason: "not a receipt hash" };
  const live = await kernelCall<{ receipt: unknown; receiptHash: string; signature: string; signer: string; tx: unknown }>(`/v1/receipts/${hash}`);
  if (live.ok) {
    const parsed = SignedReceiptSchema.safeParse({ receipt: live.data.receipt, receiptHash: live.data.receiptHash, signature: live.data.signature, signer: live.data.signer });
    if (parsed.success) return { source: "LIVE", data: { signed: parsed.data, tx: live.data.tx } };
  }
  const rec = (loadBundle()?.receipts ?? []) as unknown[];
  for (const r of rec) {
    const parsed = SignedReceiptSchema.safeParse(r);
    if (parsed.success && parsed.data.receiptHash === hash) return { source: "RECORDED", data: { signed: parsed.data, tx: null } };
  }
  return { source: "UNAVAILABLE", reason: "receipt not found live or in the recorded bundle" };
}
