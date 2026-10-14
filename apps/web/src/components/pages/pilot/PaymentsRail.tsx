import { MiniTag } from '../../design/primitives/Tag';
import type { PilotPayment } from './types';

/**
 * A horizontal dashed timeline, one node per real payment (each an explorer link the lane supplies). With none,
 * a single baseline node stands alone. Post-freeze rows carry a `late` label so they are never silently mixed in.
 */
export default function PaymentsRail({ payments, freezeStamp }: { payments: PilotPayment[]; freezeStamp?: string }) {
  return (
    <div>
      {freezeStamp ? (
        <p className="sy-mono sy-muted sy-rail__stamp">as of {freezeStamp}</p>
      ) : null}
      <div className="sy-rail" role="region" aria-label="Payments timeline, scrollable" tabIndex={0}>
        <ol className="sy-rail__list">
          {payments.length === 0 ? (
            <li className="sy-rail__node sy-rail__node--base">
              <span className="sy-rail__dot" aria-hidden="true" />
              <span className="body-text-s">Baseline: no real payment yet.</span>
            </li>
          ) : (
            payments.map((p, i) => (
              <li key={p.key} className="sy-rail__node">
                <span className="sy-rail__dot" aria-hidden="true" />
                <span className="sy-mono sy-rail__n">{String(i + 1).padStart(2, '0')}</span>
                <span className="sy-rail__net sy-mono">{p.network}</span>
                <span className="sy-rail__link">{p.link}</span>
                {p.late ? <MiniTag tone="dashed">Late</MiniTag> : null}
              </li>
            ))
          )}
        </ol>
      </div>
    </div>
  );
}
