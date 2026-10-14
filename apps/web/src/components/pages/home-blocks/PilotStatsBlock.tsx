import CountUp from '../../design/primitives/CountUp';
import { LinkButton, Stat } from '../../design/primitives/Layout';
import { ModeTag } from '../../design/primitives/Tag';

import type { PilotStatsBlockProps } from './types';

/**
 * Three numerals: businesses, real payments, value by network (never blended). Empty is honest: hollow numerals
 * and "Nothing has moved yet." There is no trend arrow, no target and no progress bar in this component's API.
 */
export default function PilotStatsBlock({ mode, businesses, payments, testnetValue, mainnetValue, baselineLine, href = '/pilot' }: PilotStatsBlockProps) {
  const empty = payments === 0 && businesses === 0;
  return (
    <section className="sy-psb" aria-labelledby="sy-psb-h">
      <div className="container sy-psb__grid">
        <header className="sy-psb__head">
          <p className="sy-eyebrow body-text-s">The pilot</p>
          <h2 id="sy-psb-h" className="heading-h1 gradient-text-black">What actually moved.</h2>
          <ModeTag mode={mode} />
          {baselineLine ? <p className="body-text-s sy-muted sy-psb__baseline">{baselineLine}</p> : null}
        </header>
        <div className="sy-psb__stats">
          <Stat label="Real payments" hollow={empty} className="sy-psb__lead">
            <CountUp value={payments} />
          </Stat>
          <Stat label="Businesses" hollow={empty}>
            <CountUp value={businesses} />
          </Stat>
          <div className="sy-psb__values">
            <Stat label="Value on testnet" hollow={empty}>
              {empty ? <span aria-label="Nothing yet">&mdash;</span> : testnetValue}
            </Stat>
            <Stat label="Value on mainnet" hollow={empty}>
              {empty ? <span aria-label="Nothing yet">&mdash;</span> : mainnetValue}
            </Stat>
          </div>
        </div>
        {empty ? <p className="body-text-m sy-muted sy-psb__empty">Nothing has moved yet.</p> : null}
        <div className="sy-psb__cta">
          <LinkButton size="m" href={href}>See the pilot -&gt;</LinkButton>
        </div>
      </div>
    </section>
  );
}
