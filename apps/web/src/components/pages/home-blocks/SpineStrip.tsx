import Appear from '../../design/primitives/Appear';
import ReceiptSealStill from '../../design/stills/ReceiptSealStill';
import TallyTokenStill from '../../design/stills/TallyTokenStill';
import VaultDrumStill from '../../design/stills/VaultDrumStill';
import { TetrapodStill } from '../../design/stills/Tetrapods';

/**
 * The spine as four typographic lines, each with its object at about 120 px, alternating sides on desktop
 * (asymmetric, not a 3-up grid). Every object is decorative and neutral: apart, empty, hollow, no verdict.
 */
export default function SpineStrip() {
  const rows = [
    { line: "Don't trust the agent.", text: 'It reads the invoice and proposes. A proposal is advisory and cannot authorize itself.', obj: <TallyTokenStill pose="apart" /> },
    { line: 'Bound it.', text: 'Signed terms, caps and a vault limit what any single decision can move.', obj: <VaultDrumStill caps={[]} /> },
    { line: 'Prove it.', text: 'Every decision leaves a receipt that anyone can recompute.', obj: <ReceiptSealStill hash={null} state="hollow" /> },
    { line: 'Invite attack.', text: 'The challenge is public, and every attempt is on the record.', obj: <TetrapodStill count={3} wave={false} /> },
  ];
  return (
    <section className="sy-spine container" aria-label="The spine">
      <ol className="sy-spine__list">
        {rows.map((r, i) => (
          <li key={r.line} className={`sy-spine__row sy-spine__row--${i % 2 === 0 ? 'l' : 'r'}`}>
            <Appear role="prose" className="sy-spine__copy">
              <h3 className="heading-h2 sy-spine__line">{r.line}</h3>
              <p className="body-text-m sy-muted">{r.text}</p>
            </Appear>
            <Appear role="figure" className="sy-spine__obj">
              {r.obj}
            </Appear>
          </li>
        ))}
      </ol>
    </section>
  );
}
