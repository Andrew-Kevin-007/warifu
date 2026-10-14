import type { ReactNode } from 'react';
import CountUp from '../../design/primitives/CountUp';
import { MiniTag, ModeTag } from '../../design/primitives/Tag';
import { formatCount } from '../../design/runtime/format';
import type { Mode } from '../../design/types';

export interface DojoRank {
  /** structural key (never untrusted text) */
  key: string;
  /** lane-supplied label (a salted handle or "Attacker n"); the kit never renders attacker-chosen text */
  label: ReactNode;
  /** oracle-scored attempts, integer */
  attempts: number;
}

/**
 * The Dojo headline: "Times the treasurer was sweet-talked: N". N is the oracle-scored loss-event count passed
 * in as a prop (from the public challenge stats); it is never hand-typed here. Zero is allowed to be funny and
 * is stated honestly: the line under it is copy, labelled as copy, and is chosen by state only.
 * The count may count up (it is an integer count); nothing else on this plate does.
 */
export default function DojoScoreboard({
  mode,
  sweetTalked,
  attempts,
  ranks,
  incident,
}: {
  mode: Mode;
  /** oracle-scored loss events */
  sweetTalked: number;
  /** distinct human attempts */
  attempts: number;
  ranks?: DojoRank[];
  /** lane link when sweetTalked > 0 */
  incident?: ReactNode;
}) {
  const none = attempts === 0;
  return (
    <section className="sy-dojo" aria-labelledby="sy-dojo-h" aria-live="polite">
      <div className="sy-dojo__top">
        <ModeTag mode={mode} />
        <span className="sy-mono sy-muted">Copy, not evidence</span>
      </div>
      <h2 id="sy-dojo-h" className="sy-dojo__head">
        <span className="sy-dojo__label">Times the treasurer was sweet-talked:</span>{' '}
        <span className={`sy-dojo__n${sweetTalked > 0 ? ' is-loss' : ''}`}>
          <CountUp value={sweetTalked} />
        </span>
      </h2>
      <p className="sy-dojo__line body-text-l">
        {none
          ? 'Nobody has tried yet. The treasurer is waiting.'
          : sweetTalked === 0
            ? 'Not once, so far. That is a tally, not a promise.'
            : 'Each one is written up, with the receipt.'}
      </p>
      <dl className="sy-dojo__facts">
        <div>
          <dt>Attempts by distinct humans</dt>
          <dd className="sy-num">{formatCount(attempts)}</dd>
        </div>
        {sweetTalked > 0 && incident ? (
          <div>
            <dt>Write-up</dt>
            <dd>{incident}</dd>
          </div>
        ) : null}
      </dl>
      {ranks && ranks.length > 0 ? (
        <ol className="sy-dojo__ranks" aria-label="Ranks by oracle-scored attempts">
          {ranks.map((r, i) => (
            <li key={r.key}>
              <span className="sy-mono sy-dojo__rank">{String(i + 1).padStart(2, '0')}</span>
              <span className="sy-dojo__who">{r.label}</span>
              <span className="sy-num">{formatCount(r.attempts)}</span>
              {i === 0 ? <MiniTag tone="plain">Most scored attempts</MiniTag> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
