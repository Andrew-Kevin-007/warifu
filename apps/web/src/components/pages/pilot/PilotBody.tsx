import DesignRoot from '../../design/DesignRoot';
import Appear from '../../design/primitives/Appear';
import { Eyebrow, FractureRule, FractureWord, Plate } from '../../design/primitives/Layout';
import { ModeTag } from '../../design/primitives/Tag';
import TallyTokenStill from '../../design/stills/TallyTokenStill';
import { formatCount } from '../../design/runtime/format';
import NetworkPlate from './NetworkPlate';
import PaymentsRail from './PaymentsRail';
import NotCountedCard from './NotCountedCard';
import type { PilotModel } from './types';

/**
 * /pilot: "What actually moved." The token turns from hollow to solid only when a real payment exists:
 * a binary state, never a fill ratio. There is no progress bar, no target and no combined figure; the API of
 * this component has no prop for them. Testnet and mainnet are always separate plates.
 */
export default function PilotBody({ model }: { model: PilotModel }) {
  const totalPayments = model.payments.length;
  const solid = totalPayments >= 1;
  return (
    <DesignRoot mode={model.mode}>
      <div className="sy-pilot">
        <header className="sy-pilot__head container">
          <div className="sy-pilot__copy">
            <Eyebrow>Pilot</Eyebrow>
            <h1 className="sy-pilot__h1">
              What actually <FractureWord>moved</FractureWord>.
            </h1>
            <p className="body-text-l sy-muted sy-pilot__lede">
              Real payments, by network, counted from chain reads. What is not counted is listed below it, with its
              reason.
            </p>
            <ModeTag mode={model.mode} />
          </div>
          <Appear role="figure" className="sy-pilot__plate">
            <Plate fig={1} caption={solid ? 'Tally token, seated: at least one real payment' : 'Tally token, hollow: no real payment yet'}>
              <div className="sy-pilot__token">
                <TallyTokenStill
                  pose={solid ? 'seated' : 'hollow'}
                  label={solid ? 'Tally token, halves seated' : 'Tally token, hollow, halves apart: nothing has moved yet'}
                />
              </div>
            </Plate>
            <p className="sy-pilot__baseline body-text-s">
              <span className="sy-muted">At the start of the pilot: spec only, </span>
              <span className="sy-num">{formatCount(model.baseline.users)}</span>
              <span className="sy-muted"> users, </span>
              <span className="sy-num">{model.baseline.value}</span>
              <span className="sy-muted"> moved.</span>
            </p>
          </Appear>
        </header>

        <div className="container">
          <FractureRule />
        </div>

        <section className="sy-pilot__nets container" aria-label="By network">
          {model.networks.map((n) => (
            <NetworkPlate key={n.network} net={n} />
          ))}
        </section>

        <section className="sy-pilot__rail container" aria-label="Payments">
          <h2 className="heading-h4">Payments</h2>
          <PaymentsRail payments={model.payments} freezeStamp={model.freezeStamp} />
        </section>

        <div className="container">
          <FractureRule />
        </div>

        <NotCountedCard />

        {model.consent ? <section className="sy-pilot__consent container">{model.consent}</section> : null}
      </div>
    </DesignRoot>
  );
}
