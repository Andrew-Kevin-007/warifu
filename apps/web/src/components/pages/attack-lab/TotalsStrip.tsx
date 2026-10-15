import CountUp from '../../design/primitives/CountUp';
import { MiniTag } from '../../design/primitives/Tag';
import { formatCount } from '../../design/runtime/format';
import type { MatrixTarget, TargetTotals } from './types';

/**
 * One column per target, equal weight: the run Symbolon column has a solid ink border, other run targets a
 * dashed one, targets not built are hatched and say "Not built yet". Loss is stated in words, never hidden
 * behind a legend. Counts are integers (count-up allowed); rates arrive as lane slots and are stated.
 */
export default function TotalsStrip({ targets, totals }: { targets: MatrixTarget[]; totals: TargetTotals[] }) {
  return (
    <ol className="sy-totals" aria-label="Totals per target">
      {targets.map((t, i) => {
        const tot = totals.find((x) => x.targetId === t.id);
        const lead = i === 0;
        if (t.status === 'not-built' || !tot) {
          return (
            <li key={t.id} className="sy-totals__col sy-totals__col--nb sy-hatch">
              <p className="sy-totals__name">{t.label}</p>
              <p className="sy-mono sy-totals__nb">Not built yet</p>
              {t.provenance ? <p className="body-text-xs sy-muted">{t.provenance}</p> : null}
            </li>
          );
        }
        const lost = tot.oracle.loss + tot.signal.loss;
        return (
          <li key={t.id} className={`sy-totals__col${lead ? ' sy-totals__col--lead' : ''}`}>
            <p className="sy-totals__name">{t.label}</p>
            <p className="sy-totals__big">
              <CountUp value={lost} className="sy-totals__k" />
              <span className="sy-totals__of"> of </span>
              <span className="sy-num">{formatCount(tot.applicable)}</span>
            </p>
            <p className="body-text-s sy-totals__sentence">
              {lost > 0 ? (
                <span className="sy-totals__lossword">
                  <MiniTag tone="loss">Loss</MiniTag> on {formatCount(lost)} of {formatCount(tot.applicable)} applicable attacks.
                </span>
              ) : (
                <>No loss on {formatCount(tot.applicable)} applicable attacks.</>
              )}
            </p>
            <dl className="sy-totals__dl">
              <dt>Not applicable</dt>
              <dd className="sy-num">{formatCount(tot.notApplicable)}</dd>
              <dt>Trials</dt>
              <dd className="sy-num">{formatCount(tot.trials)}</dd>
              <dt>Oracle-scored</dt>
              <dd className="sy-num">
                {formatCount(tot.oracle.loss)} lost / {formatCount(tot.oracle.applicable)}
              </dd>
              <dt>Signal-scored</dt>
              <dd className="sy-num">
                {formatCount(tot.signal.loss)} lost / {formatCount(tot.signal.applicable)}
              </dd>
              <dt>Loss rate, as provided</dt>
              <dd>{tot.lossRate}</dd>
            </dl>
          </li>
        );
      })}
    </ol>
  );
}
