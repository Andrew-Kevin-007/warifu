// Maps a Loss Bound Certificate (docs/16) into the designed /certificate model. All wording comes from the certificate view (fixed
// texts of the algorithm version); amounts stay strings and become slots; shapes use basis points from bigint arithmetic (INV-10).
// No certificate = UNVERIFIED with NO number: the standard exclusions still lead, and nothing is estimated.
import { EXCLUSIONS } from '@symbolon/blast-radius/lbc';
import type { CertificateView } from '@symbolon/blast-radius/lbc';
import type { LossBoundCertificate } from '@symbolon/schemas';
import type { Mode, Validity } from '@/components/design/types';
import { ratioBp } from '@/components/design/runtime/ratio';
import type { CertificateModel } from '@/components/pages/certificate/types';

const short = (a: string): string => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

export function certificateModel(args: { vault: string; mode: Mode; cert: LossBoundCertificate | null; view: CertificateView | null }): CertificateModel {
  const { vault, mode, cert, view } = args;
  if (cert === null || view === null) {
    return {
      mode,
      validity: null,
      vaultShort: short(vault),
      exclusions: EXCLUSIONS.map((e) => ({ id: e.id, text: e.text })),
      headline: null,
      asOf: null,
      certHash: null,
      horizons: [],
      alarmed: null,
      assumptions: [],
      validation: null,
      verifyCommand: `pnpm lbc verify ${vault} --rpc <your-own-rpc-url> --artifact <foundry-artifact.json>`,
      staleDiff: null,
    };
  }
  const label = view.status.label;
  const validity: Validity = label === 'VALID' ? 'VALID' : label === 'STALE' ? 'STALE' : 'UNVERIFIED';
  const balance = cert.inputs.balanceBaseUnits;
  const v = cert.validation;
  const slot = (units: string, shown: string) => <span className="sy-mono" title={`${units} base units`}>{shown}</span>;
  return {
    mode,
    validity: label === 'MISMATCH' ? 'UNVERIFIED' : validity,
    vaultShort: short(cert.subject.vault),
    exclusions: view.exclusions.map((e) => ({ id: e.id, text: e.text })),
    headline: (
      <p className="heading-h4" data-cert-headline>
        {view.headline}
      </p>
    ),
    asOf: { block: String(cert.asOf.blockNumber), blockHash: cert.asOf.blockHash },
    certHash: view.certHash,
    horizons: view.horizons.map((h) => ({ label: h.label, value: slot(h.valueBaseUnits, h.valueDisplay), bp: ratioBp(h.valueBaseUnits, balance), binding: [...h.binding] })),
    alarmed: { label: 'Alarmed', value: <span className="body-text-s">{view.alarmed}</span>, assumes: [...cert.bounds.T3c.alarmed.assumes] },
    assumptions: view.assumptions.map((a) => ({ id: a.id, text: a.text })),
    validation:
      v === null
        ? null
        : { trials: v.t3Trials, violations: v.t3Violations, upper95: v.upper95, tightness: v.tightness, codeMatch: v.codeMatch.status === 'MATCH' ? 'MATCH' : v.codeMatch.status === 'MISMATCH' ? 'MISMATCH' : 'NOT_CHECKED' },
    verifyCommand: view.verifyCommand,
    staleDiff:
      label === 'STALE' || label === 'MISMATCH'
        ? {
            reasons: [...view.status.reasons],
            before: <span className="sy-mono">{view.diff.map((d) => `${d.path}: ${d.document}`).join('; ') || 'recorded certificate'}</span>,
            after: <span className="sy-mono">{view.diff.map((d) => `${d.path}: ${d.recomputed}`).join('; ') || 'current chain state'}</span>,
          }
        : null,
  };
}
