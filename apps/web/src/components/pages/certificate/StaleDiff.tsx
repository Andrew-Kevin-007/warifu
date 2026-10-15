import type { ReactNode } from 'react';
import { MiniTag } from '../../design/primitives/Tag';

/** STALE only: two columns (before / after), the halves metaphor, and the reasons the verifier reported. */
export default function StaleDiff({ diff }: { diff: { reasons: string[]; before: ReactNode; after: ReactNode } }) {
  return (
    <section className="sy-stale container" data-sy-section="diff" aria-label="What changed">
      <h2 className="heading-h4">What changed</h2>
      <ul className="sy-stale__reasons" aria-label="Reasons">
        {diff.reasons.map((r) => (
          <li key={r}>
            <MiniTag tone="dashed">{r}</MiniTag>
          </li>
        ))}
      </ul>
      <div className="sy-stale__cols">
        <div className="sy-stale__col sy-stale__col--before">
          <p className="sy-mono sy-stale__h">When computed</p>
          <div>{diff.before}</div>
        </div>
        <div className="sy-stale__col sy-stale__col--after">
          <p className="sy-mono sy-stale__h">Now</p>
          <div>{diff.after}</div>
        </div>
      </div>
    </section>
  );
}
