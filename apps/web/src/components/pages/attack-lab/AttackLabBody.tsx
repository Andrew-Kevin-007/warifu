import DesignRoot from '../../design/DesignRoot';
import AttackLatticeGrid, { LatticeLegend } from '../../design/stills/AttackLatticeGrid';
import { LatticeFocusProvider } from '../../design/runtime/LatticeFocus';
import { Eyebrow, FractureRule, FractureWord, NodeFrame, PositionsList } from '../../design/primitives/Layout';
import { MiniTag, ModeTag } from '../../design/primitives/Tag';
import Appear from '../../design/primitives/Appear';
import { provenanceMode } from '../../design/runtime/states';
import { formatCount, shortHash } from '../../design/runtime/format';
import MatrixTable from './MatrixTable';
import TotalsStrip from './TotalsStrip';
import type { AttackLabModel } from './types';

/**
 * /attack-lab: "Every attack. Every baseline." The matrix is the hero; the lattice is its relief map.
 * The DOM lattice is the accessible control (a canvas skin may sit above it on desktop). Warifu's own loss
 * cell renders at full strength. Presentational: all data and money formatting arrive from the lane.
 */
export default function AttackLabBody({ model }: { model: AttackLabModel }) {
  const mode = provenanceMode(model.mode, model.recordedOutputs);
  const lattice = {
    attackIds: model.attacks.map((a) => a.id),
    targets: model.targets.map((t) => ({ id: t.id, label: t.label, status: t.status })),
    cells: model.cells.map((c) => ({
      attackId: c.attackId,
      targetId: c.targetId,
      outcome: c.outcome,
      scoring: c.scoring ?? undefined,
      reason: c.reason,
    })),
  };
  const lossCells = model.cells.filter((c) => c.outcome === 'LOSS').length;
  const ranTargets = model.targets.filter((t) => t.status === 'run').length;
  const caption = `Attack lattice: ${model.attacks.length} attacks against ${model.targets.length} targets, ${ranTargets} run. ${
    lossCells > 0 ? `${lossCells} cells are losses.` : 'No cell is a loss.'
  }`;

  return (
    <DesignRoot mode={mode}>
      <LatticeFocusProvider>
        <div className="sy-lab">
          <a className="sy-skip" href="#sy-lab-matrix">Skip to the matrix</a>
          <header className="sy-lab__head container">
            <div className="sy-lab__tags">
              <Eyebrow>Attack lab</Eyebrow>
              <ModeTag mode={mode} />
              <span className="sy-mono sy-muted">
                {model.matrixMode} / {model.harness} / {model.oracleVersion}
              </span>
            </div>
            <h1 className="sy-lab__h1">
              Every <FractureWord>attack</FractureWord>. Every baseline.
            </h1>
          </header>

          <section className="sy-lab__lattice container" aria-label="Attack lattice">
            <NodeFrame className="sy-lab__lattice-frame">
              <Appear role="figure">
                <AttackLatticeGrid model={lattice} caption={caption} />
              </Appear>
              <LatticeLegend className="sy-lab__legend" />
            </NodeFrame>
          </section>

          <section className="sy-lab__totals container" aria-label="Totals">
            <TotalsStrip targets={model.targets} totals={model.totals} />
            <p className="body-text-xs sy-muted sy-lab__denominators">
              Not-applicable attacks stay in the table with their reason and are excluded from the denominators.
              Signal-scored rows are tagged: they are not oracle-scored.
            </p>
          </section>

          <div className="container">
            <FractureRule />
          </div>

          <section id="sy-lab-matrix" className="sy-lab__matrix container" aria-label="Matrix">
            <MatrixTable attacks={model.attacks} targets={model.targets} cells={model.cells} caption={caption} />
          </section>

          <div className="container">
            <FractureRule />
          </div>

          <section className="sy-lab__blocks container">
            <div className="sy-lab__block">
              <h2 className="heading-h4">Hold-out</h2>
              {model.holdout === null || model.holdout.status === 'not-run' ? (
                <p className="body-text-m sy-muted">
                  Not run. {model.holdout?.reason ?? 'No hold-out result is available.'}
                </p>
              ) : (
                <dl className="sy-lab__dl">
                  <dt>Root hash</dt>
                  <dd className="sy-mono" title={model.holdout.rootHash}>{model.holdout.rootHash ? shortHash(model.holdout.rootHash, 14, 10) : 'unrecorded'}</dd>
                  <dt>Attempts</dt>
                  <dd className="sy-num">{formatCount(model.holdout.n)}</dd>
                  <dt>Losses</dt>
                  <dd className="sy-num">{formatCount(model.holdout.k)}</dd>
                  <dt>Upper bound, as provided</dt>
                  <dd>{model.holdout.upperBound}</dd>
                </dl>
              )}
            </div>

            <div className="sy-lab__block">
              <h2 className="heading-h4">Honest corpus</h2>
              {model.honest.length === 0 ? (
                <p className="body-text-m sy-muted"><span className="sy-hollow-num">Not computed</span></p>
              ) : (
                <ul className="sy-lab__honest">
                  {model.honest.map((h) => (
                    <li key={h.targetId}>
                      <span className="sy-mono">{h.targetId}</span>
                      <span className="sy-num">
                        {formatCount(h.released)} released of {formatCount(h.n)}; {formatCount(h.wrongfulRejects)} wrongful rejects
                      </span>
                      <span className="sy-muted">upper bound as provided: </span>
                      {h.wilsonUpper}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="sy-lab__block">
              <h2 className="heading-h4">Reproducibility</h2>
              <dl className="sy-lab__dl">
                <dt>Git sha</dt>
                <dd className="sy-mono">{model.reproducibility.gitSha ?? 'unrecorded'}</dd>
                <dt>Seed</dt>
                <dd className="sy-mono">{model.reproducibility.seed}</dd>
                <dt>Models</dt>
                <dd>{model.reproducibility.models}</dd>
                {model.reproducibility.manifestHash ? (
                  <>
                    <dt>Fixture manifest</dt>
                    <dd className="sy-mono">{shortHash(model.reproducibility.manifestHash, 14, 10)}</dd>
                  </>
                ) : null}
              </dl>
              {mode === 'simulated' ? <MiniTag tone="dashed">No model was called: simulated</MiniTag> : null}
            </div>
          </section>

          {model.limitations.length > 0 ? (
            <section className="sy-lab__limits container" aria-label="Known limits">
              <h2 className="heading-h4">Known limits</h2>
              <PositionsList items={model.limitations.map((l, i) => ({ id: `L-${String(i + 1).padStart(2, '0')}`, title: l }))} />
            </section>
          ) : null}
        </div>
      </LatticeFocusProvider>
    </DesignRoot>
  );
}
