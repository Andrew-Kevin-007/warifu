import { MiniTag } from '../../design/primitives/Tag';
import { PositionsList } from '../../design/primitives/Layout';

const ROWS: { title: string; text: string }[] = [
  { title: 'Challenge attempts', text: 'Attack traffic is never customer traffic, whatever it does.' },
  { title: 'House attackers', text: 'Our own red team. Counted in the attack lab, not here.' },
  { title: 'Demo tenants', text: 'Seed and demo data are labelled demo and kept out of every public figure.' },
  { title: 'Internal payments', text: 'Wallets we control paying each other is not adoption.' },
];

export default function NotCountedCard() {
  return (
    <section className="sy-nc container" aria-labelledby="sy-nc-h">
      <div className="sy-card-black sy-on-black sy-nc__card">
        <h2 id="sy-nc-h" className="heading-h3 sy-nc__title">Not counted.</h2>
        <PositionsList
          tone="black"
          items={ROWS.map((r) => ({ title: r.title, meta: r.text, tags: <MiniTag tone="dashed">Excluded</MiniTag> }))}
        />
      </div>
    </section>
  );
}
