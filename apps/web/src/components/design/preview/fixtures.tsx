// PREVIEW FIXTURES. Everything here is labelled FIXTURE / SIMULATED and is built to NEVER look like real data:
// counts are structural, money is an em dash, hashes are visibly repeating patterns, and every plate that uses
// them carries a FIXTURE tag. Nothing in this file is a claim, a metric or a result.
import type { ReactNode } from 'react';
import type { LatticeModel } from '../stills/AttackLatticeGrid';
import type { CellOutcome } from '../types';
import type { AttackLabModel, MatrixCell, ScoreSplit } from '../../pages/attack-lab/types';
import type { CertificateModel } from '../../pages/certificate/types';
import type { ChallengeModel } from '../../pages/challenge/types';
import type { JudgeProps } from '../../pages/judge/types';
import type { PilotModel } from '../../pages/pilot/types';
import type { AttackMatrixBlockProps, PilotStatsBlockProps } from '../../pages/home-blocks/types';
import { ModeTag } from '../primitives/Tag';

export const FIXTURE_HASH = `0x${'5ca1ab1e'.repeat(8)}`;
export const FIXTURE_HASH_B = `0x${'d15ea5ed'.repeat(8)}`;

/** A money slot for previews: never a number. */
export const moneyDash: ReactNode = <span className="sy-mono" aria-label="fixture amount">&mdash;</span>;

function fixtureBanner(text: string): ReactNode {
  return (
    <div className="sy-fixture-bar">
      <ModeTag mode="fixture" />
      <span className="body-text-xs">{text}</span>
    </div>
  );
}

// -------------------------------------------------------------------- judge
export function judgeFixture(mode: 'live' | 'recorded' | 'simulated' | 'fixture' = 'fixture'): JudgeProps {
  return {
    mode,
    heroFit: 'unknown',
    card1: {
      fit: 'mismatch',
      checkIds: ['K-04', 'K-07', 'K-12'],
      outcomes: [
        { target: 'Symbolon', outcome: 'BLOCKED' },
        { target: 'B1, release on model output', outcome: 'LOSS', loss: moneyDash },
        { target: 'B0, escrow baseline', outcome: 'NOT_RUN' },
      ],
      vaultReverts: true,
    },
    card2: { receiptHash: FIXTURE_HASH, sealState: 'sealed', kind: 'fixture' },
    card3: {
      validity: 'VALID',
      exclusions: [
        { id: 'X-OWNER-KEY', text: 'fixture' },
        { id: 'X-WORK', text: 'fixture' },
        { id: 'X-AVAIL', text: 'fixture' },
      ],
      horizons: [
        { label: '1m', bp: 400 },
        { label: '1h', bp: 1500 },
        { label: '6h', bp: 3800 },
        { label: '24h', bp: 6200, binding: true },
        { label: '7d', bp: 9100 },
      ],
      alarmed: { label: 'alarmed', bp: 2100 },
      command: 'pnpm lbc verify <vault>',
    },
    slots: {
      modeBar: fixtureBanner('Preview fixture: layout only. Nothing on this page is a result.'),
      card1Claim: <p className="sy-mono">pay: FIXTURE payee<br />amount: FIXTURE</p>,
      card1Verdict: (
        <p>
          <strong>REJECT</strong> <span className="sy-muted">(fixture)</span>
        </p>
      ),
      card3StatusChip: undefined,
      card3Headline: (
        <p>
          <span className="sy-muted">FIXTURE sentence: </span>
          <span className="sy-num-big">0</span>
        </p>
      ),
      card4Scoreboard: <p className="body-text-s">Scoreboard slot (lane). <span className="sy-mono">FIXTURE</span></p>,
      card5PilotSummary: <p className="body-text-m">Pilot summary slot (lane). <span className="sy-mono">FIXTURE</span></p>,
    },
  };
}

// -------------------------------------------------------------------- attack lab
const ATTACK_IDS = Array.from({ length: 24 }, (_, i) => `ATK-${String(i + 1).padStart(2, '0')}`);

// The distribution below mirrors the SHAPE of attack-matrix/1 (one oracle loss on the Symbolon row, signal-scored
// rows, N/A cells, two targets not built) so every cell grammar is exercised. It is a FIXTURE, not the results file.
const SYM: Record<string, CellOutcome> = {};
ATTACK_IDS.forEach((id, i) => {
  SYM[id] = 'BLOCKED';
  if ([3, 8, 15].includes(i)) SYM[id] = 'ESCALATED';
  if (i === 21) SYM[id] = 'LOSS';
  if (i === 18) SYM[id] = 'NOT_RUN';
  if (i === 5) SYM[id] = 'HELD';
});
const SIGNAL = new Set([0, 8, 18, 22, 23]);
const NA_B1 = new Set([16, 17]);

function cell(attackId: string, targetId: string, outcome: CellOutcome, i: number): MatrixCell {
  const signal = SIGNAL.has(i);
  return {
    attackId,
    targetId,
    outcome,
    scoring: outcome === 'N/A' || outcome === 'NOT_RUN' ? null : signal ? 'signal' : 'oracle',
    reason: outcome === 'N/A' ? 'No equivalent exists for this target (fixture reason).' : outcome === 'NOT_RUN' ? 'Not exercised in unit mode (fixture reason).' : undefined,
    checksFired: outcome === 'BLOCKED' || outcome === 'ESCALATED' ? ['K-04'] : [],
    loss: outcome === 'LOSS' ? moneyDash : undefined,
    vaultReverts: outcome === 'BLOCKED' ? true : null,
  };
}

function split(cells: MatrixCell[], scoring: 'oracle' | 'signal'): ScoreSplit {
  const s = cells.filter((c) => c.scoring === scoring);
  const n = (o: CellOutcome) => s.filter((c) => c.outcome === o).length;
  return { applicable: s.length, loss: n('LOSS'), blocked: n('BLOCKED'), escalated: n('ESCALATED'), held: n('HELD'), noop: n('NOOP'), notRun: n('NOT_RUN') };
}

export function attackLabFixture(): AttackLabModel {
  const symCells = ATTACK_IDS.map((id, i) => cell(id, 'symbolon', SYM[id], i));
  const b1Cells = ATTACK_IDS.map((id, i) => cell(id, 'b1', NA_B1.has(i) ? 'N/A' : 'LOSS', i));
  const cells = [...symCells, ...b1Cells];
  const mk = (targetId: string, c: MatrixCell[]) => {
    const applicable = c.filter((x) => x.outcome !== 'N/A').length;
    return {
      targetId,
      attacks: c.length,
      applicable,
      notApplicable: c.length - applicable,
      oracle: split(c, 'oracle'),
      signal: split(c, 'signal'),
      trials: 0,
      lossTrials: 0,
      lossRate: moneyDash,
    };
  };
  return {
    mode: 'simulated',
    recordedOutputs: false,
    harness: 'attack-harness (fixture)',
    oracleVersion: 'oracle (fixture)',
    matrixMode: 'unit',
    targets: [
      { id: 'symbolon', label: 'Symbolon', status: 'run' },
      { id: 'b0', label: 'B0 escrow', status: 'not-built', provenance: 'vendoring pending' },
      { id: 'b1', label: 'B1 naive', status: 'run' },
      { id: 'b2', label: 'B2 hardened', status: 'not-built', provenance: 'not yet written' },
    ],
    attacks: ATTACK_IDS.map((id) => ({ id })),
    cells,
    totals: [mk('symbolon', symCells), { ...mk('b0', []), attacks: 0 }, mk('b1', b1Cells), { ...mk('b2', []), attacks: 0 }],
    holdout: { status: 'not-run', reason: 'The hold-out set is written outside this repository and is not read by this page (fixture text).' },
    honest: [{ targetId: 'symbolon', n: 0, released: 0, wrongfulRejects: 0, wilsonUpper: moneyDash }],
    reproducibility: { gitSha: null, seed: 'fixture', models: 'none: no model was called (fixture)', manifestHash: FIXTURE_HASH_B },
    limitations: [
      'Fixture limitation one: engagements are templates with placeholder signatures (SIMULATED).',
      'Fixture limitation two: signal-scored rows have no oracle-expressible loss and are tagged.',
    ],
  };
}

export function latticeFromModel(m: AttackLabModel): LatticeModel {
  return {
    attackIds: m.attacks.map((a) => a.id),
    targets: m.targets.map((t) => ({ id: t.id, label: t.label, status: t.status })),
    cells: m.cells.map((c) => ({ attackId: c.attackId, targetId: c.targetId, outcome: c.outcome, scoring: c.scoring ?? undefined, reason: c.reason })),
  };
}

export function matrixBlockFixture(): AttackMatrixBlockProps {
  const m = attackLabFixture();
  return {
    mode: 'simulated',
    recordedOutputs: false,
    lattice: latticeFromModel(m),
    targets: m.targets.map((t) => {
      const tot = m.totals.find((x) => x.targetId === t.id);
      return { id: t.id, label: t.label, status: t.status, loss: tot ? tot.oracle.loss + tot.signal.loss : 0, applicable: tot ? tot.applicable : 0 };
    }),
  };
}

// -------------------------------------------------------------------- certificate
export function certificateFixture(validity: 'VALID' | 'STALE' | 'UNVERIFIED' = 'VALID'): CertificateModel {
  const horizons = [
    { label: '1m', bp: 300, binding: ['T3'] },
    { label: '1h', bp: 1200, binding: ['T3'] },
    { label: '6h', bp: 3400, binding: ['T3'] },
    { label: '24h', bp: 6000, binding: ['T3', 'T1'] },
    { label: '7d', bp: 9000, binding: ['T1'] },
  ];
  return {
    mode: 'fixture',
    validity,
    vaultShort: '0xFIXT…URE0',
    exclusions: [
      { id: 'X-OWNER-KEY', text: 'The owner key is outside the bound. Fixture text.' },
      { id: 'X-WORK', text: 'Work quality is not assessed. Fixture text.' },
      { id: 'X-AVAIL', text: 'Availability is not bounded. Fixture text.' },
    ],
    headline: (
      <p className="heading-h4">
        Fixture sentence for the generated headline. <span className="sy-num-big">0</span>
      </p>
    ),
    asOf: validity === 'UNVERIFIED' ? null : { block: 'fixture', blockHash: FIXTURE_HASH },
    certHash: validity === 'UNVERIFIED' ? null : FIXTURE_HASH_B,
    horizons: horizons.map((h) => ({ label: h.label, bp: validity === 'UNVERIFIED' ? null : h.bp, binding: h.binding, value: validity === 'UNVERIFIED' ? <span className="sy-muted">Not computed</span> : moneyDash })),
    alarmed: { label: 'Alarmed', value: moneyDash, assumes: ['A-MON'] },
    assumptions: [
      { id: 'A-EVID', text: 'Evidence providers are not all colluding. Fixture text.' },
      { id: 'A-MON', text: 'A monitor and a guardian are watching. Fixture text.' },
      { id: 'A-OWNER-KEY', text: 'The owner key is not compromised. Fixture text.' },
    ],
    validation: validity === 'UNVERIFIED' ? null : { trials: 0, violations: 0, upper95: 'fixture', tightness: 'fixture', codeMatch: 'NOT_CHECKED' },
    verifyCommand: 'pnpm lbc verify <vault> --rpc <url>',
    staleDiff:
      validity === 'STALE'
        ? {
            reasons: ['CONFIG_CHANGED'],
            before: <span className="sy-mono">config hash, before (fixture)</span>,
            after: <span className="sy-mono">config hash, after (fixture)</span>,
          }
        : null,
  };
}

// -------------------------------------------------------------------- challenge
const ONE_CLICK = ATTACK_IDS.map((id, i) => ({ id, caption: `Fixture caption ${String.fromCharCode(65 + (i % 26))}` }));
export function challengeFixture(variant: 'zero' | 'loss' | 'normal' = 'zero'): ChallengeModel {
  const sb =
    variant === 'zero'
      ? { distinctHuman: 0, lossEvents: 0, byPredicate: [], upperBound: null }
      : variant === 'loss'
        ? { distinctHuman: 3, lossEvents: 1, byPredicate: [{ predicate: 'O1', count: 1 }], upperBound: null, incidentLink: <span className="sy-mono">incident note (lane)</span> }
        : { distinctHuman: 12, lossEvents: 0, byPredicate: [], upperBound: <span className="sy-mono">fixture bound</span> };
  return {
    mode: 'fixture',
    scoreboard: sb,
    oneClick: ONE_CLICK,
    benign: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `BC-${n}`, caption: `Fixture control ${n}` })),
    resultTick: 0,
    scenarios: [
      { id: 'S-A', label: 'Scenario A' },
      { id: 'S-B', label: 'Scenario B' },
      { id: 'S-C', label: 'Scenario C' },
    ],
    maxBytes: 4096,
    activeTileId: null,
    slots: {
      modeBar: fixtureBanner('Preview fixture: layout only. No attempt has been made.'),
      captcha: <p className="body-text-xs sy-muted">CAPTCHA slot (lane)</p>,
      resultPanel: <p className="body-text-s">Attempt result panel slot (lane, safety component).</p>,
      certificate: <p className="body-text-s">Certificate chip slot (lane).</p>,
      proveOnchain: <p className="body-text-s">Prove on-chain slot (lane). TESTNET.</p>,
      crossOrigin: <p className="body-text-s">Cross-origin call to action slot (lane).</p>,
      disclaimer: <p className="body-text-s">Attack traffic is not customer traffic. Synthetic data only.</p>,
    },
  };
}

// -------------------------------------------------------------------- pilot
export function pilotFixture(variant: 'empty' | 'some' = 'empty'): PilotModel {
  const some = variant === 'some';
  return {
    mode: 'fixture',
    baseline: { users: 0, value: moneyDash },
    networks: [
      { network: 'testnet', businesses: some ? 2 : 0, payments: some ? 3 : 0, payees: some ? 2 : 0, value: moneyDash },
      { network: 'mainnet', businesses: 0, payments: 0, payees: 0, value: moneyDash },
    ],
    payments: some
      ? [
          { key: 'f1', network: 'testnet', link: <span className="sy-mono">explorer link (lane)</span> },
          { key: 'f2', network: 'testnet', link: <span className="sy-mono">explorer link (lane)</span> },
          { key: 'f3', network: 'testnet', link: <span className="sy-mono">explorer link (lane)</span>, late: true },
        ]
      : [],
    freezeStamp: 'fixture stamp',
  };
}

export function pilotBlockFixture(): PilotStatsBlockProps {
  return { mode: 'fixture', businesses: 0, payments: 0, testnetValue: moneyDash, mainnetValue: moneyDash, baselineLine: 'Baseline at start: spec only.' };
}
