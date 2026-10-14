import AttackLatticeGrid, { LatticeLegend } from '../../design/stills/AttackLatticeGrid';
import { LatticeFocusProvider } from '../../design/runtime/LatticeFocus';
import { LinkButton } from '../../design/primitives/Layout';
import { ModeTag } from '../../design/primitives/Tag';
import Appear from '../../design/primitives/Appear';
import CountUp from '../../design/primitives/CountUp';
import { provenanceMode } from '../../design/runtime/states';
import { formatCount } from '../../design/runtime/format';
import type { AttackMatrixBlockProps } from './types';

/**
 * Replaces the third-party logo strips on `/`: the real matrix, compact. Every attack, against every baseline.
 * A loss is stated in words and in the count; targets not built are hatched and say so. Counts are integers.
 */
export default function AttackMatrixBlock({ mode, recordedOutputs, lattice, targets, href = '/attack-lab' }: AttackMatrixBlockProps) {
  const m = provenanceMode(mode, recordedOutputs);
  const caption = `Attack matrix: ${lattice.attackIds.length} attacks against ${lattice.targets.length} targets.`;
  return (
    <section className="sy-amb" aria-labelledby="sy-amb-h">
      <div className="container">
        <header className="sy-amb__head">
          <p className="sy-eyebrow body-text-s">Attack matrix</p>
          <h2 id="sy-amb-h" className="heading-h1 gradient-text-black">Every attack, against every baseline.</h2>
          <ModeTag mode={m} />
        </header>
        <LatticeFocusProvider>
          <Appear role="figure" className="sy-amb__lattice">
            <AttackLatticeGrid model={lattice} size="compact" caption={caption} interactive={false} />
            <LatticeLegend className="sy-amb__legend" kinds={['blocked', 'escalated', 'held', 'loss', 'na', 'notbuilt']} />
          </Appear>
        </LatticeFocusProvider>
        <ul className="sy-amb__totals" aria-label="Losses per target">
          {targets.map((t) => (
            <li key={t.id} className={`sy-amb__t${t.status === 'not-built' ? ' sy-hatch' : ''}`} data-status={t.status}>
              <span className="sy-amb__tname">{t.label}</span>
              {t.status === 'not-built' ? (
                <span className="sy-mono sy-muted">Not built yet</span>
              ) : (
                <>
                  <span className="heading-h3 sy-amb__tnum">
                    <CountUp value={t.loss} /> <span className="sy-muted">of</span> {formatCount(t.applicable)}
                  </span>
                  <span className="body-text-xs sy-muted">{t.loss > 0 ? 'applicable attacks lost' : 'applicable attacks, none lost'}</span>
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="sy-amb__cta">
          <LinkButton size="m" href={href}>See the matrix -&gt;</LinkButton>
        </div>
      </div>
    </section>
  );
}
