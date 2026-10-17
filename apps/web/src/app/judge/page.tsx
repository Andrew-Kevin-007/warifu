import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';
import JudgeBody from '@/components/pages/judge/JudgeBody';
import type { JudgeOutcomeRow, JudgeProps } from '@/components/pages/judge/types';
import { ratioBp } from '@/components/design/runtime/ratio';
import type { CellOutcome } from '@/components/design/types';
import { EXCLUSIONS } from '@symbolon/blast-radius/lbc';
import type { Stats } from '@/components/challenge/types';
import { money } from '@/server/attack-lab-model';
import { kernelCall } from '@/server/kernel-client';
import { getCertificate, isAddress } from '@/server/public-data';
import { loadAttackMatrix, loadAttackMeta, loadBundle } from '@/server/recorded';

export const metadata: Metadata = {
  title: `Judge path | ${BRAND.name}`,
  description: 'A five-card path through the evidence: watch an attack, verify a receipt, recompute a bound, try to break it, see real use.',
};
export const dynamic = 'force-dynamic';

const CHALLENGE_URL = process.env.NEXT_PUBLIC_CHALLENGE_URL ?? null;
const OUTCOMES = new Set(['BLOCKED', 'ESCALATED', 'HELD', 'LOSS', 'NOOP', 'NOT_RUN', 'N/A']);
const asOutcome = (o: string | undefined): CellOutcome => (o !== undefined && OUTCOMES.has(o) ? (o as CellOutcome) : 'NOT_RUN');

// Five cards, each from data that says where it came from. Card 1 reads the committed attack matrix (RECORDED, SIMULATED harness); card 3
// the certificate (LIVE re-check or RECORDED copy, else UNVERIFIED with no number); cards 4 and 5 the sandbox and pilot figures when the
// kernel answers. Nothing here is typed by hand.
export default async function Page() {
  const matrix = loadAttackMatrix();
  const meta = loadAttackMeta();
  const bundle = loadBundle();
  const vault = process.env.NEXT_PUBLIC_SANDBOX_VAULT ?? '';
  const hasVault = isAddress(vault);

  const [cert, stats, pilot] = await Promise.all([
    hasVault ? getCertificate(vault) : Promise.resolve(null),
    kernelCall<Stats>('/v1/challenge/stats'),
    kernelCall<{ stats: { network: string; releases: number; valueBaseUnits: string }[] }>('/v1/pilot-stats'),
  ]);

  const row = (id: string, target: string) => matrix?.attacks.find((a) => a.attackId === id && a.target === target);
  const sym = row('ATK-10', 'symbolon');
  const outcomes: JudgeOutcomeRow[] = [...(matrix?.targets ?? [])]
    .sort((a, b) => (a.id === 'symbolon' ? -1 : b.id === 'symbolon' ? 1 : a.id.localeCompare(b.id)))
    .map((t) => {
      const r = row('ATK-10', t.id);
      return { target: t.id === 'symbolon' ? BRAND.name : t.label, outcome: asOutcome(r?.outcome), ...(r !== undefined && r.lossBaseUnits !== '0' ? { loss: money(r.lossBaseUnits) } : {}) };
    });

  const live = cert !== null && cert.source === 'LIVE';
  const certData = cert !== null && cert.source !== 'UNAVAILABLE' ? cert.data : null;
  const validity = certData === null ? null : certData.view.status.label === 'VALID' ? 'VALID' : certData.view.status.label === 'STALE' ? 'STALE' : 'UNVERIFIED';
  const balance = certData?.certificate.inputs.balanceBaseUnits ?? '0';
  const receiptHash = ((bundle?.receipts ?? []) as { receiptHash?: string }[])[0]?.receiptHash ?? null;

  const props: JudgeProps = {
    brandName: BRAND.name,
    mode: stats.ok || live ? 'live' : 'recorded',
    heroFit: 'unknown',
    card1: { fit: 'mismatch', checkIds: sym?.checksFired ?? [], outcomes, vaultReverts: null },
    card2: { receiptHash, sealState: receiptHash === null ? 'hollow' : 'sealed', kind: 'real' },
    card3: {
      validity,
      exclusions: (certData?.view.exclusions ?? EXCLUSIONS).map((e) => ({ id: e.id, text: e.text })),
      horizons: (certData?.view.horizons ?? []).map((h) => ({ label: h.label, bp: ratioBp(h.valueBaseUnits, balance), binding: h.binding.length > 0 })),
      alarmed: certData === null ? null : { label: 'alarmed', bp: ratioBp(certData.certificate.bounds.T3c.alarmed.value, balance) },
      command: certData?.view.verifyCommand ?? `pnpm lbc verify ${hasVault ? vault : '<vault>'}`,
    },
    hrefs: { run: '/attack-lab', audit: '/audit', certificate: hasVault ? `/certificate/${vault}` : '/certificate', challenge: CHALLENGE_URL ?? '/challenge', pilot: '/pilot' },
    slots: {
      card1Claim: <p className="sy-mono">{meta['ATK-10']?.caption ?? 'ATK-10, see the attack lab'}</p>,
      card1Verdict: <p><strong>{sym?.outcome ?? 'Not recorded'}</strong> <span className="sy-muted">(recorded, simulated harness)</span></p>,
      card3Headline: certData === null ? undefined : <p className="body-text-m">{certData.view.headline}</p>,
      card4Scoreboard: stats.ok ? (
        <p className="body-text-s">
          <span className="sy-num">{stats.data.attempts.distinctHuman}</span> distinct human attempts, <span className="sy-num">{stats.data.lossEvents.total}</span> loss events.
        </p>
      ) : (
        <p className="body-text-s sy-muted">The live sandbox is not answering; the challenge page shows the recorded attack set.</p>
      ),
      card5PilotSummary: pilot.ok && pilot.data.stats.some((s) => s.releases > 0) ? (
        <p className="body-text-m">{pilot.data.stats.map((s) => `${s.releases} payment(s) on ${s.network}`).join('; ')}</p>
      ) : (
        <p className="body-text-m sy-muted">No real payments counted yet. This page will say so until someone pays.</p>
      ),
    },
  };
  return <JudgeBody {...props} />;
}
