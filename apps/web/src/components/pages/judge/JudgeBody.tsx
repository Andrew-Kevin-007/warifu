import DesignRoot from '../../design/DesignRoot';
import Appear from '../../design/primitives/Appear';
import { Eyebrow, FractureRule, FractureWord, LinkButton, NodeFrame, Plate } from '../../design/primitives/Layout';
import { MiniTag, ModeTag, ValidityPill } from '../../design/primitives/Tag';
import TallyTokenStill from '../../design/stills/TallyTokenStill';
import ReceiptSealStill from '../../design/stills/ReceiptSealStill';
import HorizonStepsStill from '../../design/stills/HorizonStepsStill';
import { TetrapodStill } from '../../design/stills/Tetrapods';
import { cellGrammar } from '../../design/runtime/states';
import { shortHash } from '../../design/runtime/format';
import { tokenPoseFor } from '../../design/runtime/states';
import JudgeCard from './JudgeCard';
import DoesNotDoCard from './DoesNotDoCard';
import type { JudgeProps } from './types';

/**
 * /judge: "Check it without us in the room." Five cards, each a two-half plate: what was claimed on the left,
 * what the check says on the right, meeting at the stepped fracture. Fit / non-fit is the grammar of the page.
 * Presentational: data and behaviour arrive as props and slots from the lane.
 */
export default function JudgeBody(p: JudgeProps) {
  const h = p.hrefs ?? {};
  const heroPose = p.heroFit === 'match' ? 'seated' : p.heroFit === 'mismatch' ? 'mismatch' : 'hollow';
  const c3Pose = tokenPoseFor(p.card3.validity);
  const frozen = p.mode !== 'live';

  return (
    <DesignRoot mode={p.mode}>
      <div className="sy-judge">
        {p.slots.modeBar ? <div className="sy-judge__mode container">{p.slots.modeBar}</div> : null}

        <header className="sy-judge__head container">
          <div className="sy-judge__head-copy">
            <Eyebrow>Guided review</Eyebrow>
            <h1 className="sy-judge__h1">
              Check it without <FractureWord>us</FractureWord> in the room.
            </h1>
            <Appear role="prose">
              <p className="sy-judge__lede body-text-l">
                Five checks, in order. Each runs on data that says what it is: live, recorded or simulated. Nothing
                here asks you to take our word for it.
              </p>
            </Appear>
          </div>
          <div className={`sy-judge__hero${frozen ? '' : ' sy-float'}`}>
            <TallyTokenStill
              pose={heroPose}
              label={
                heroPose === 'hollow'
                  ? `${p.brandName} tally token, halves apart, no fit checked yet`
                  : heroPose === 'seated'
                    ? `${p.brandName} tally token, halves seated`
                    : `${p.brandName} tally token, halves that do not fit`
              }
            />
          </div>
        </header>

        <div className="container">
          <FractureRule />
        </div>

        <ol className="sy-judge__list container" aria-label="Five checks">
          <JudgeCard
            index={0}
            side="plate-left"
            title="Watch it get fooled, and not lose money"
            text="A forged invoice fools the model. The kernel compares the claim with the signed engagement and refuses, and the vault would revert regardless. The agent's claim stays advisory."
            tag={<ModeTag mode={p.mode} />}
            cta={<LinkButton size="s" href={h.run ?? '/replay'}>{p.mode === 'live' ? 'Run it ->' : 'View the recorded run ->'}</LinkButton>}
          >
            <div className="sy-duo" data-fit={p.card1.fit}>
              <div className="sy-duo__half sy-duo__half--a">
                <div className="sy-duo__face">
                  <p className="sy-duo__label sy-mono">Claimed by the agent</p>
                  <div className="sy-duo__content">
                    {p.slots.card1Claim ?? <p className="body-text-s sy-muted">No claim loaded.</p>}
                  </div>
                </div>
              </div>
              <div className="sy-duo__half sy-duo__half--b">
                <div className="sy-duo__face">
                  <p className="sy-duo__label sy-mono">Kernel check</p>
                  <div className="sy-duo__content">
                    {p.slots.card1Verdict ?? <p className="body-text-s">Not run yet.</p>}
                    {p.card1.checkIds.length > 0 ? (
                      <ul className="sy-duo__ids" aria-label="Checks that fired">
                        {p.card1.checkIds.map((id) => (
                          <li key={id}>
                            <MiniTag tone="solid">{id}</MiniTag>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
            <ul className="sy-judge__outcomes">
              {p.card1.outcomes.map((o) => {
                const g = cellGrammar(o.outcome, 'run');
                return (
                  <li key={o.target} className="sy-judge__outcome" data-kind={g.kind}>
                    <span className="sy-judge__outcome-target">{o.target}</span>
                    <span className="sy-judge__outcome-word">{g.label}</span>
                    {o.loss ? <span className="sy-judge__outcome-loss">{o.loss}</span> : null}
                  </li>
                );
              })}
              <li className="sy-judge__outcome" data-kind={p.card1.vaultReverts === null ? 'notrun' : 'vault'}>
                <span className="sy-judge__outcome-target">Vault</span>
                <span className="sy-judge__outcome-word">
                  {p.card1.vaultReverts === null
                    ? 'Not simulated'
                    : p.card1.vaultReverts
                      ? 'The release would revert'
                      : 'The release would not revert'}
                </span>
              </li>
            </ul>
          </JudgeCard>

          <JudgeCard
            index={1}
            side="plate-right"
            title="Verify a receipt yourself"
            text="A receipt is a hash over what the kernel decided and what it saw. Recompute it offline; one changed byte changes one tick of the seal."
            tag={p.card2.kind === 'fixture' ? <ModeTag mode="fixture" /> : <ModeTag mode={p.mode} />}
            cta={p.slots.card2ReceiptLink ?? <LinkButton size="s" href={h.audit ?? '/audit'}>Open the verifier -&gt;</LinkButton>}
          >
            <Plate caption={p.card2.kind === 'fixture' ? 'Receipt seal, fixture receipt' : 'Receipt seal'} fig={2}>
              <div className="sy-judge__seal">
                <ReceiptSealStill
                  hash={p.card2.receiptHash}
                  state={p.card2.sealState}
                  label={
                    p.card2.receiptHash === null
                      ? 'Receipt seal, hollow: no receipt'
                      : p.card2.sealState === 'sealed'
                        ? 'Receipt seal, fingerprint of the receipt hash'
                        : 'Receipt seal, not verified'
                  }
                />
              </div>
              {p.card2.receiptHash ? <p className="sy-mono sy-judge__hash">{shortHash(p.card2.receiptHash, 12, 10)}</p> : null}
            </Plate>
          </JudgeCard>

          <JudgeCard
            index={2}
            side="plate-left"
            title="Recompute the loss bound"
            text="The certificate states a bound, the assumptions it rests on, and what it excludes. Recompute it from on-chain state; if the configuration changed, it says STALE."
            tag={<ModeTag mode={p.mode} />}
            cta={<LinkButton size="s" href={h.certificate ?? '/certificate'}>Open the certificate -&gt;</LinkButton>}
          >
            <NodeFrame className="sy-judge__cert">
              <div className="sy-judge__cert-head">
                {p.card3.exclusions.length > 0 ? (
                  <p className="sy-judge__excl body-text-xs">
                    <span className="sy-mono">Excludes </span>
                    {p.card3.exclusions.map((e, i) => (
                      <span key={e.id}>
                        {i > 0 ? ', ' : ''}
                        <span className="sy-mono">{e.id}</span>
                      </span>
                    ))}
                  </p>
                ) : (
                  <p className="sy-judge__excl body-text-xs sy-muted">No exclusions loaded.</p>
                )}
                {p.slots.card3StatusChip ?? (p.card3.validity ? <ValidityPill status={p.card3.validity} /> : <ValidityPill status="UNVERIFIED" />)}
              </div>
              <div className="sy-judge__cert-body">
                <div className="sy-judge__cert-headline">
                  {p.card3.validity === null || p.card3.validity === 'UNVERIFIED' ? (
                    <span className="sy-num-big sy-hollow-num" aria-label="Not computed">Not computed</span>
                  ) : (
                    p.slots.card3Headline
                  )}
                </div>
                <div className="sy-judge__cert-steps">
                  <HorizonStepsStill steps={p.card3.horizons} alarmed={p.card3.alarmed ?? null} state={p.card3.validity} label="Loss bound by horizon, as a stair of slabs" />
                </div>
              </div>
              <div className="sy-judge__cert-foot">
                <div className="sy-judge__cert-token" aria-hidden="true">
                  <TallyTokenStill pose={c3Pose} showSeam />
                </div>
                <code className="sy-judge__cmd sy-mono">{p.card3.command}</code>
              </div>
              {p.slots.card3WhatIf ? <div className="sy-judge__whatif">{p.slots.card3WhatIf}</div> : null}
            </NodeFrame>
          </JudgeCard>

          <JudgeCard
            index={3}
            side="plate-right"
            title="Try to break it"
            text="Make the system pay the wrong person, in the wrong amount, or twice. Every attempt is public, and attack traffic is not customer traffic."
            tag={<ModeTag mode={p.mode} />}
            cta={p.slots.card4CrossOriginLink ?? <LinkButton size="s" href={h.challenge ?? '/challenge'}>Open the challenge -&gt;</LinkButton>}
          >
            <div className="sy-judge__wall">
              <TetrapodStill />
              {p.slots.card4Scoreboard ? <div className="sy-judge__score">{p.slots.card4Scoreboard}</div> : null}
            </div>
          </JudgeCard>

          <JudgeCard
            index={4}
            side="plate-left"
            title="See the real users"
            text="What actually moved, by network, and what is not counted. An empty page is the honest answer until someone pays."
            tag={<ModeTag mode={p.mode} />}
            cta={<LinkButton size="s" href={h.pilot ?? '/pilot'}>See the pilot -&gt;</LinkButton>}
          >
            <NodeFrame className="sy-judge__pilot">
              {p.slots.card5PilotSummary ?? <p className="body-text-m sy-muted">Pilot figures are read live from the pilot page.</p>}
            </NodeFrame>
          </JudgeCard>
        </ol>

        <div className="container">
          <FractureRule />
        </div>

        <DoesNotDoCard brandName={p.brandName} />
      </div>
    </DesignRoot>
  );
}
