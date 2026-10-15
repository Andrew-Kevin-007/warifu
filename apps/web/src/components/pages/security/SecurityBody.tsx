import DesignRoot from '../../design/DesignRoot';
import Appear from '../../design/primitives/Appear';
import { Eyebrow, FractureRule } from '../../design/primitives/Layout';
import TocRail from './TocRail';
import ClaimColumns from './ClaimColumns';
import type { SecurityModel } from './types';

/**
 * /security: typography only. No 3D, no motion beyond R1 (prose) and R2 (rules). The page never inserts copy:
 * every word arrives from the lane's reviewed markdown, so the claims lint governs it, not this file.
 */
export default function SecurityBody({ model }: { model: SecurityModel }) {
  return (
    <DesignRoot mode="live">
      <div className="sy-sec-page">
        <a className="sy-skip" href="#sy-sec-main">Skip to the content</a>
        <header className="sy-sec-page__head container">
          <Eyebrow>Security</Eyebrow>
          <h1 className="sy-sec-page__h1">{model.title}</h1>
        </header>
        <div className="container">
          <FractureRule />
        </div>
        <div className="sy-sec-page__cols container">
          <TocRail items={model.toc} />
          <div id="sy-sec-main" className="sy-sec-page__main">
            <Appear role="prose" className="sy-prose">
              {model.prose}
            </Appear>
            {model.claims ? <ClaimColumns we={model.claims.we} wedont={model.claims.wedont} /> : null}
            {model.contact ? <div className="sy-card-black sy-on-black sy-sec-page__contact">{model.contact}</div> : null}
          </div>
        </div>
      </div>
    </DesignRoot>
  );
}
