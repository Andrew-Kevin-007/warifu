import { shortHash } from '../runtime/format';
import ReceiptSealStill, { type SealState } from './ReceiptSealStill';
import TallyTokenStill from './TallyTokenStill';

export type NiceTryVerdict = 'REJECT' | 'HOLD' | 'ESCALATE';

/**
 * A shareable "nice try" card for a refused payment (props only; no fetching).
 *
 * `message` is the one human line TEMPLATED from the reason code by the lane (never model prose, never attacker
 * text, never rendered next to an Approve action). The card never reproduces untrusted content: the only strings
 * it draws are a closed verdict word, a reason code, a receipt hash and that templated line. It is a record of a
 * refusal, so the halves do not seat; the seal is hollow unless the caller states the receipt verified.
 *
 * The aspect is fixed (1.91 : 1, the share-image ratio) so the same markup is the on-page card and the source for
 * the lane's image route.
 */
export default function NiceTryCard({
  brandName,
  verdict,
  reasonCode,
  receiptHash,
  message,
  sealState,
  className = '',
}: {
  brandName: string;
  verdict: NiceTryVerdict;
  reasonCode: string;
  receiptHash: string;
  message: string;
  sealState: SealState;
  className?: string;
}) {
  return (
    <article className={`sy-nicetry ${className}`.trim()} aria-label={`${brandName}: payment refused`}>
      <div className="sy-nicetry__art" aria-hidden="true">
        <TallyTokenStill pose="mismatch" />
      </div>
      <div className="sy-nicetry__body">
        <p className="sy-mono sy-nicetry__brand">{brandName}</p>
        <p className="sy-nicetry__msg">{message}</p>
        <p className="sy-nicetry__try">Nice try.</p>
        <dl className="sy-nicetry__facts">
          <div>
            <dt>Verdict</dt>
            <dd>
              <span className="sy-mini sy-mini--solid">{verdict}</span>
            </dd>
          </div>
          <div>
            <dt>Reason</dt>
            <dd className="sy-mono">{reasonCode}</dd>
          </div>
          <div>
            <dt>Receipt</dt>
            <dd className="sy-mono" title={receiptHash}>
              {shortHash(receiptHash, 12, 8)}
            </dd>
          </div>
        </dl>
      </div>
      <div className="sy-nicetry__seal" aria-hidden="true">
        <ReceiptSealStill hash={receiptHash} state={sealState} />
      </div>
    </article>
  );
}
