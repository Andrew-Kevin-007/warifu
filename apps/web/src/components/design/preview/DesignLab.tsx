// DesignLab: every object x every state in one page. Preview only; all data is FIXTURE and labelled.
import DesignRoot from '../DesignRoot';
import { FractureRule, Plate } from '../primitives/Layout';
import { MiniTag, ModeTag, ValidityPill } from '../primitives/Tag';
import TallyTokenStill from '../stills/TallyTokenStill';
import ReceiptSealStill from '../stills/ReceiptSealStill';
import VaultDrumStill from '../stills/VaultDrumStill';
import HorizonStepsStill from '../stills/HorizonStepsStill';
import HankoSeal from '../stills/HankoSeal';
import NiceTryCard from '../stills/NiceTryCard';
import { TetrapodStill, FooterTetrapodsStill } from '../stills/Tetrapods';
import HeroStill from '../stills/HeroStill';
import AttackLatticeGrid, { LatticeLegend } from '../stills/AttackLatticeGrid';
import { LatticeFocusProvider } from '../runtime/LatticeFocus';
import type { TokenPose } from '../types';
import { attackLabFixture, FIXTURE_BRAND, FIXTURE_HASH, latticeFromModel } from './fixtures';

const POSES: TokenPose[] = ['apart', 'approach', 'scan', 'seated', 'mismatch', 'hollow'];

export default function DesignLab() {
  const steps = [
    { label: '1m', bp: 400 },
    { label: '1h', bp: 1500 },
    { label: '6h', bp: 3800 },
    { label: '24h', bp: 6200, binding: true },
    { label: '7d', bp: 9100 },
  ];
  return (
    <DesignRoot mode="fixture">
      <div className="container sy-lab-page">
        <h1 className="heading-h2">Design lab <ModeTag mode="fixture" /></h1>
        <p className="body-text-m sy-muted">Every object in every state. Fixture data only: nothing here is a result.</p>

        <h2 className="heading-h4">Tally token poses</h2>
        <div className="sy-lab-grid">
          {POSES.map((p, i) => (
            <Plate key={p} fig={i + 1} caption={p}>
              <TallyTokenStill pose={p} scanLine={p === 'scan'} label={`Token pose ${p}`} />
            </Plate>
          ))}
        </div>
        <FractureRule />

        <h2 className="heading-h4">Chips</h2>
        <p className="sy-lab-row">
          <ValidityPill status="VALID" /> <ValidityPill status="STALE" /> <ValidityPill status="UNVERIFIED" /> <ValidityPill status="MISMATCH" />
        </p>
        <p className="sy-lab-row">
          <ModeTag mode="live" /> <ModeTag mode="recorded" /> <ModeTag mode="simulated" /> <ModeTag mode="demo" /> <ModeTag mode="fixture" />{' '}
          <MiniTag tone="loss">Loss</MiniTag> <MiniTag tone="dashed">Excluded</MiniTag>
        </p>
        <FractureRule />

        <h2 className="heading-h4">Receipt seal, vault drum, horizon stair</h2>
        <div className="sy-lab-grid">
          <Plate caption="seal sealed"><ReceiptSealStill hash={FIXTURE_HASH} state="sealed" label="Seal" /></Plate>
          <Plate caption="seal failed"><ReceiptSealStill hash={FIXTURE_HASH} state="failed" label="Seal failed" /></Plate>
          <Plate caption="seal hollow"><ReceiptSealStill hash={null} state="hollow" label="Seal hollow" /></Plate>
          <Plate caption="drum"><VaultDrumStill caps={[{ bp: 9000, label: 'a' }, { bp: 5000, label: 'b' }, { bp: null, label: 'c' }]} /></Plate>
          <Plate caption="stair VALID"><HorizonStepsStill steps={steps} alarmed={{ label: 'alarmed', bp: 2000 }} state="VALID" /></Plate>
          <Plate caption="stair STALE"><HorizonStepsStill steps={steps} state="STALE" /></Plate>
          <Plate caption="stair UNVERIFIED"><HorizonStepsStill steps={steps} state="UNVERIFIED" /></Plate>
        </div>
        <FractureRule />

        <h2 className="heading-h4">Hanko</h2>
        <div className="sy-lab-grid">
          <Plate caption="intact"><HankoSeal state="VALID" brandName={FIXTURE_BRAND} value="FIXTURE" asOfBlock="fixture" /></Plate>
          <Plate caption="cracked"><HankoSeal state="STALE" brandName={FIXTURE_BRAND} value={null} asOfBlock={null} /></Plate>
          <Plate caption="blank"><HankoSeal state="UNVERIFIED" brandName={FIXTURE_BRAND} value={null} asOfBlock={null} /></Plate>
        </div>
        <FractureRule />

        <h2 className="heading-h4">Nice try card</h2>
        <NiceTryCard
          brandName={FIXTURE_BRAND}
          verdict="REJECT"
          reasonCode="K-04"
          receiptHash={FIXTURE_HASH}
          message="A document asked for the money to go to a different wallet."
          sealState="hollow"
        />
        <FractureRule />

        <h2 className="heading-h4">Lattice</h2>
        <LatticeFocusProvider>
          <AttackLatticeGrid model={latticeFromModel(attackLabFixture())} caption="Fixture lattice" />
          <LatticeLegend />
        </LatticeFocusProvider>
        <FractureRule />

        <h2 className="heading-h4">Tetrapods and hero Still</h2>
        <TetrapodStill />
        <FooterTetrapodsStill />
        <HeroStill />
      </div>
    </DesignRoot>
  );
}
