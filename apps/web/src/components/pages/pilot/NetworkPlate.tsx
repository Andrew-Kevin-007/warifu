import CountUp from '../../design/primitives/CountUp';
import { NodeFrame, Stat } from '../../design/primitives/Layout';
import type { NetworkSummary } from './types';

const NAME: Record<NetworkSummary['network'], string> = { testnet: 'Testnet', mainnet: 'Mainnet' };

/** One network, on its own plate. Empty networks show hollow numerals, never a plausible-looking zero trend. */
export default function NetworkPlate({ net }: { net: NetworkSummary }) {
  const empty = net.payments === 0 && net.businesses === 0;
  return (
    <NodeFrame className="sy-net" as="article">
      <header className="sy-net__head">
        <h3 className="heading-h4">{NAME[net.network]}</h3>
        <span className="sy-mono sy-net__tag" data-sy-role="network-tag">{net.network}</span>
      </header>
      <div className="sy-net__stats">
        <Stat label="Businesses" hollow={empty}>
          <CountUp value={net.businesses} />
        </Stat>
        <Stat label="Real payments" hollow={empty}>
          <CountUp value={net.payments} />
        </Stat>
        <Stat label="Distinct payees" hollow={empty}>
          <CountUp value={net.payees} />
        </Stat>
        <Stat label="Value moved" hollow={empty}>
          {empty ? <span aria-label="Nothing yet">&mdash;</span> : net.value}
        </Stat>
      </div>
      {empty ? <p className="body-text-s sy-muted sy-net__empty">Nothing has moved yet.</p> : null}
    </NodeFrame>
  );
}
