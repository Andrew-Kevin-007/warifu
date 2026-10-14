import { MiniTag } from '../../design/primitives/Tag';
import { PositionsList } from '../../design/primitives/Layout';

// Static, hand-reviewed scope statements. No numbers. This is designed as a premium moment, not fine print.
const ROWS: { id: string; title: string; text: string }[] = [
  {
    id: 'X-WORK',
    title: 'Work quality',
    text: 'It checks paperwork against signed terms. Whether the work was any good is the owner’s call.',
  },
  {
    id: 'X-OWNER-KEY',
    title: 'A compromised owner key',
    text: 'An owner key can change the terms the kernel enforces. The bound assumes the key is not stolen.',
  },
  {
    id: 'X-AVAIL',
    title: 'Availability',
    text: 'The service can be down. The vault then holds rather than releases, and nothing moves.',
  },
  {
    id: 'X-CODE',
    title: 'Unaudited code',
    text: 'The contracts and the kernel have not had an external audit. The attack suite is evidence, not a substitute.',
  },
  {
    id: 'X-SIM',
    title: 'Simulated planner results',
    text: 'Planner figures are labelled SIMULATED. They are not observed outcomes and are never counted as traction.',
  },
];

export default function DoesNotDoCard() {
  return (
    <section className="sy-dnd container" aria-labelledby="sy-dnd-h">
      <div className="sy-card-black sy-on-black sy-dnd__card">
        <div className="sy-dnd__head">
          <p className="sy-mono sy-dnd__eyebrow">Scope</p>
          <h2 id="sy-dnd-h" className="heading-h2 sy-dnd__title">What this does not do.</h2>
        </div>
        <PositionsList
          tone="black"
          items={ROWS.map((r) => ({
            id: r.id,
            title: r.title,
            meta: r.text,
            tags: <MiniTag tone="dashed">Not covered</MiniTag>,
          }))}
        />
      </div>
    </section>
  );
}
