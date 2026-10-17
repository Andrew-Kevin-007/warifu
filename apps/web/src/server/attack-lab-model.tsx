// Maps the committed attack-matrix/1 file (RECORDED, DEC-016) into the designed /attack-lab model. Nothing is typed by hand (INV-18):
// every count, rate and amount below is read from the file or computed from it, and each is shown with its basis.
import { formatBaseUnits } from '@symbolon/schemas';
import type { CellOutcome } from '@/components/design/types';
import type { AttackLabModel, MatrixCell, ScoreSplit, TargetTotals } from '@/components/pages/attack-lab/types';
import type { AttackMatrix, AttackMetaEntry, TargetTotals as FileTotals } from './recorded';

const OUTCOMES = new Set<string>(['BLOCKED', 'ESCALATED', 'HELD', 'LOSS', 'NOOP', 'NOT_RUN', 'N/A']);
const asOutcome = (o: string): CellOutcome => (OUTCOMES.has(o) ? (o as CellOutcome) : 'NOT_RUN');

export const money = (baseUnits: string) => <span className="sy-mono">{formatBaseUnits(baseUnits, 6)} USDC</span>;

function splitOf(s: FileTotals['oracleScored']): ScoreSplit {
  return { applicable: s.applicable, loss: s.loss, blocked: s.blocked, escalated: s.escalated, held: s.held, noop: s.noop, notRun: s.notRun };
}

function totalsOf(t: FileTotals): TargetTotals {
  return {
    targetId: t.target,
    attacks: t.attacks,
    applicable: t.applicable,
    notApplicable: t.notApplicable,
    oracle: splitOf(t.oracleScored),
    signal: splitOf(t.signalScored),
    trials: t.trials,
    lossTrials: t.lossTrials,
    lossRate: (
      <span>
        {t.lossRate.k}/{t.lossRate.n} loss trials, 95 % upper bound {t.lossRate.upper95.toFixed(4)} <span className="sy-muted">({t.lossRate.upper95Method})</span>
      </span>
    ),
  };
}

export function attackLabModel(m: AttackMatrix, meta: Record<string, AttackMetaEntry>): AttackLabModel {
  const ids = Array.from(new Set(m.applicability.map((a) => a.attackId))).sort();
  const cells: MatrixCell[] = [];
  for (const t of m.targets) {
    for (const id of ids) {
      const row = m.attacks.find((a) => a.attackId === id && a.target === t.id);
      if (row !== undefined) {
        cells.push({
          attackId: id,
          targetId: t.id,
          outcome: asOutcome(row.outcome),
          scoring: row.outcome === 'N/A' || row.outcome === 'NOT_RUN' ? null : row.scoring === 'signal' ? 'signal' : 'oracle',
          reason: row.outcome === 'N/A' || row.outcome === 'NOT_RUN' ? row.notes[0] : undefined,
          checksFired: row.checksFired,
          ...(row.lossBaseUnits !== '0' ? { loss: money(row.lossBaseUnits) } : {}),
        });
        continue;
      }
      const app = m.applicability.find((a) => a.attackId === id && a.target === t.id);
      cells.push({
        attackId: id,
        targetId: t.id,
        outcome: app?.applicable === false ? 'N/A' : 'NOT_RUN',
        scoring: null,
        reason: app?.applicable === false ? app.reason : `${t.status}`,
        checksFired: [],
      });
    }
  }
  return {
    mode: 'recorded',
    recordedOutputs: m.provenance.recordedOutputs,
    harness: m.harness,
    oracleVersion: m.oracleVersion,
    matrixMode: m.mode,
    targets: m.targets.map((t) => ({ id: t.id, label: t.label, status: t.status === 'run' ? 'run' : 'not-built', provenance: t.provenance })),
    attacks: ids.map((id) => ({ id, ...(meta[id] === undefined ? {} : { title: meta[id].title }) })),
    cells,
    totals: m.totals.map(totalsOf),
    holdout: { status: 'not-run', reason: m.holdout.reason ?? 'The hold-out set is written outside this repository and is not read by this page.' },
    honest: m.honest.map((h) => ({
      targetId: h.target,
      n: h.n,
      released: h.released,
      wrongfulRejects: h.wrongfulReject.k,
      wilsonUpper: <span>{h.wrongfulReject.wilsonUpper.toFixed(3)} <span className="sy-muted">(Wilson 95 % upper bound on wrongful rejects)</span></span>,
    })),
    reproducibility: { gitSha: m.provenance.gitSha, seed: (m.provenance as unknown as { seed?: string }).seed ?? 'base', models: m.provenance.models, manifestHash: (m.provenance as unknown as { fixtureManifestSha256?: string }).fixtureManifestSha256 },
    limitations: m.limitations,
  };
}
