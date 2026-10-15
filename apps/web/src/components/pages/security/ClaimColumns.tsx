import type { ReactNode } from 'react';
import { FractureRule } from '../../design/primitives/Layout';

/** "What we claim / what we do not claim": two columns separated by a (rotated on desktop) fracture rule. */
export default function ClaimColumns({ we, wedont }: { we: ReactNode; wedont: ReactNode }) {
  return (
    <section className="sy-claims" aria-label="What we claim and what we do not">
      <div className="sy-claims__col">
        <h3 className="sy-claims__h">What we claim</h3>
        <div className="sy-prose">{we}</div>
      </div>
      <div className="sy-claims__sep" aria-hidden="true">
        <FractureRule vertical />
      </div>
      <div className="sy-claims__col">
        <h3 className="sy-claims__h">What we do not claim</h3>
        <div className="sy-prose">{wedont}</div>
      </div>
    </section>
  );
}
