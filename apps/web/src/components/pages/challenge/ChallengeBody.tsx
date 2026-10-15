import DesignRoot from '../../design/DesignRoot';
import Appear from '../../design/primitives/Appear';
import { Eyebrow, FractureRule, FractureWord, NodeFrame } from '../../design/primitives/Layout';
import { TetrapodStill } from '../../design/stills/Tetrapods';
import AttackTileGrid from './AttackTileGrid';
import ScoreboardPlate from './ScoreboardPlate';
import DojoScoreboard from './DojoScoreboard';
import WriteYourOwnPlate from './WriteYourOwnPlate';
import type { ChallengeModel } from './types';

/**
 * /challenge: "Make it pay the wrong person." The rule sentence, then a scoreboard whose zeros are honest.
 * Visual grammar: an attack tile is a periwinkle half that does not fit; a benign tile fits. This body has no
 * wallet code, no cookies, no storage and no network; results and the CAPTCHA arrive as slots from the lane.
 */
export default function ChallengeBody({ model }: { model: ChallengeModel }) {
  const m = model;
  return (
    <DesignRoot mode={m.mode} profile="challenge">
      <div className="sy-ch">
        {m.slots.modeBar ? <div className="container sy-ch__mode">{m.slots.modeBar}</div> : null}
        {m.slots.degradeBanner ? <div className="container sy-ch__mode">{m.slots.degradeBanner}</div> : null}

        <header className="sy-ch__head container">
          <div className="sy-ch__head-copy">
            <Eyebrow>The Dojo</Eyebrow>
            <h1 className="sy-ch__h1">
              <FractureWord>Sweet-talk</FractureWord> the treasurer.
            </h1>
            <p className="body-text-l sy-ch__rule">
              {m.brandName} reads invoices; a kernel and a vault decide. Your job is to get money to the wrong place, in the wrong amount, or twice. Nothing else counts.
            </p>
          </div>
          <div className="sy-ch__wall" data-tick={m.resultTick}>
            <TetrapodStill />
          </div>
        </header>

        <div className="container sy-ch__score">
          <DojoScoreboard mode={m.mode} sweetTalked={m.scoreboard.lossEvents} attempts={m.scoreboard.distinctHuman} ranks={m.ranks} incident={m.scoreboard.incidentLink} />
          <ScoreboardPlate sb={m.scoreboard} mode={m.mode} dojo />
        </div>

        <div className="container">
          <FractureRule />
        </div>

        <div className="sy-ch__cols container">
          <div className="sy-ch__a">
            <section className="sy-ch__card" aria-labelledby="sy-ch-a">
              <header className="sy-ch__card-head">
                <h2 id="sy-ch-a" className="heading-h4">One click</h2>
                <p className="body-text-s sy-muted">Each tile is a known attack with its halves out of true. Press one and watch the kernel.</p>
              </header>
              <Appear role="figure">
                <AttackTileGrid
                  tiles={m.oneClick}
                  kind="attack"
                  label="One-click attacks"
                  activeId={m.activeTileId}
                  disabledIds={m.disabledTileIds}
                  onSelect={m.onSelectTile}
                />
              </Appear>
            </section>

            <section className="sy-ch__card" aria-labelledby="sy-ch-b">
              <header className="sy-ch__card-head">
                <h2 id="sy-ch-b" className="heading-h4">Benign controls</h2>
                <p className="body-text-s sy-muted">These fit. They should pay. A refusal here is a false reject and is counted.</p>
              </header>
              <Appear role="figure">
                <AttackTileGrid
                  tiles={m.benign}
                  kind="benign"
                  label="Benign controls"
                  activeId={m.activeTileId}
                  disabledIds={m.disabledTileIds}
                  onSelect={m.onSelectTile}
                />
              </Appear>
            </section>
          </div>

          <aside className="sy-ch__aside" aria-label="Attempt result" aria-live="polite">
            <NodeFrame className="sy-ch__result">
              {m.slots.resultPanel ?? <p className="body-text-s sy-muted">Press a tile or submit your own text. The kernel&apos;s answer appears here.</p>}
            </NodeFrame>
          </aside>

          <div className="sy-ch__b">
            <section className="sy-ch__card" aria-labelledby="sy-ch-c">
              <header className="sy-ch__card-head">
                <h2 id="sy-ch-c" className="heading-h4">Write your own</h2>
                <p className="body-text-s sy-muted">Your text is treated as hostile data. It is never rendered as markup and never executed.</p>
              </header>
              {m.slots.writeYourOwn ?? <WriteYourOwnPlate maxBytes={m.maxBytes} scenarios={m.scenarios} captcha={m.slots.captcha} />}
            </section>

            {m.slots.certificate ? (
              <section className="sy-ch__card" aria-labelledby="sy-ch-d">
                <header className="sy-ch__card-head">
                  <h2 id="sy-ch-d" className="heading-h4">Certificate</h2>
                </header>
                {m.slots.certificate}
              </section>
            ) : null}

            {m.slots.proveOnchain ? (
              <section className="sy-ch__card sy-ch__chain" aria-labelledby="sy-ch-e">
                <header className="sy-ch__card-head">
                  <h2 id="sy-ch-e" className="heading-h4">Prove it on-chain</h2>
                  <p className="body-text-s sy-muted">Testnet only. Nothing here moves real funds.</p>
                </header>
                {m.slots.proveOnchain}
              </section>
            ) : null}
          </div>
        </div>

        {m.slots.crossOrigin ? <div className="container sy-ch__cross">{m.slots.crossOrigin}</div> : null}

        <footer className="sy-ch__foot container">
          {m.slots.disclaimer ?? (
            <p className="body-text-s">Attack traffic is not customer traffic. Synthetic data only.</p>
          )}
        </footer>
      </div>
    </DesignRoot>
  );
}
