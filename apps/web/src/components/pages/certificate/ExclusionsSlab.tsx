import { PositionsList } from '../../design/primitives/Layout';

/** The black slab that sits ABOVE the number: what the bound does not cover. Never collapsed, never below. */
export default function ExclusionsSlab({ exclusions }: { exclusions: { id: string; text: string }[] }) {
  return (
    <section className="sy-excl container" data-sy-section="exclusions" aria-labelledby="sy-excl-h">
      <div className="sy-card-black sy-on-black sy-excl__card">
        <p className="sy-mono sy-excl__eyebrow">Read this first</p>
        <h2 id="sy-excl-h" className="heading-h4 sy-excl__title">What this bound excludes</h2>
        {exclusions.length === 0 ? (
          <p className="body-text-m sy-excl__none">This certificate lists no exclusions. That is itself worth a question.</p>
        ) : (
          <PositionsList tone="black" items={exclusions.map((e) => ({ id: e.id, title: e.text }))} />
        )}
      </div>
    </section>
  );
}
