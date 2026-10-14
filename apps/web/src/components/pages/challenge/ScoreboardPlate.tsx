import CountUp from '../../design/primitives/CountUp';
import { MiniTag, ModeTag } from '../../design/primitives/Tag';
import { Stat } from '../../design/primitives/Layout';
import type { Mode } from '../../design/types';
import type { ScoreboardModel } from './types';

/**
 * Three stats, each tagged LIVE / RECORDED. States, all from props:
 * - no independent attempts: attempts show 0, the bound is a hollow dash and the line says so;
 * - losses > 0: the loss count and the predicates, and NO 3/N line (a rule-of-three bound only applies at zero);
 * - normal: counts plus the bound text the lane formatted.
 * Counts count up; the bound never does.
 */
export default function ScoreboardPlate({ sb, mode, dojo = false }: { sb: ScoreboardModel; mode: Mode; dojo?: boolean }) {
  const noAttempts = sb.distinctHuman === 0;
  const lossy = sb.lossEvents > 0;
  return (
    <section className="sy-score" aria-label="Scoreboard" aria-live="polite">
      <div className="sy-score__grid">
        {dojo ? null : (
          <Stat label="Distinct human attempts" tag={<ModeTag mode={mode} />}>
            <CountUp value={sb.distinctHuman} />
          </Stat>
        )}
        {dojo ? null : (
          <Stat label="Loss events" tag={<ModeTag mode={mode} />} caption={lossy ? 'Money reached the wrong place, in the wrong amount, or twice.' : undefined}>
            <span className={lossy ? 'sy-score__loss' : undefined}>
              <CountUp value={sb.lossEvents} />
            </span>
          </Stat>
        )}
        <Stat label="Upper bound on the loss rate" hollow={noAttempts || lossy} tag={<ModeTag mode={mode} />} caption={noAttempts ? 'No independent attempts yet.' : lossy ? 'A rule-of-three bound does not apply once a loss exists.' : undefined}>
          {noAttempts || lossy || sb.upperBound === null ? <span aria-label="Not computed">&mdash;</span> : sb.upperBound}
        </Stat>
      </div>
      {lossy ? (
        <div className="sy-score__lossrow">
          <ul className="sy-score__preds" aria-label="Loss predicates">
            {sb.byPredicate.map((p) => (
              <li key={p.predicate}>
                <MiniTag tone="loss">
                  {p.predicate} x {p.count}
                </MiniTag>
              </li>
            ))}
          </ul>
          {!dojo && sb.incidentLink ? <div className="sy-score__incident">{sb.incidentLink}</div> : null}
        </div>
      ) : null}
      {sb.oracleDisagrees ? (
        <p className="sy-score__disagree">
          <MiniTag tone="dashed">Oracle disagreement</MiniTag> <span className="body-text-s">Two scorers disagree on at least one attempt; it is not counted until resolved.</span>
        </p>
      ) : null}
    </section>
  );
}
