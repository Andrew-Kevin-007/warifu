import DesignRoot from '../../design/DesignRoot';
import Appear from '../../design/primitives/Appear';
import { Eyebrow, FractureRule, NodeFrame, PositionsList } from '../../design/primitives/Layout';
import { MiniTag, ModeTag, ValidityPill } from '../../design/primitives/Tag';
import HorizonStepsStill from '../../design/stills/HorizonStepsStill';
import TallyTokenStill from '../../design/stills/TallyTokenStill';
import VaultDrumStill from '../../design/stills/VaultDrumStill';
import { formatCount, shortHash } from '../../design/runtime/format';
import { tokenPoseFor } from '../../design/runtime/states';
import ExclusionsSlab from './ExclusionsSlab';
import VerifyBlock from './VerifyBlock';
import StaleDiff from './StaleDiff';
import type { CertificateModel } from './types';

/**
 * /certificate/[vault]: "A bound you can recompute."
 * DOM order is fixed by spec (docs/16) and asserted by a test: exclusions -> headline -> status chip -> horizon
 * table -> alarmed variant -> assumptions -> validation -> verify command -> stale diff.
 * UNVERIFIED shows no digit anywhere in the numeral region. No decorative object sits between the table and
 * its meaning; the stair and the token are state icons beside the plate, never part of the verdict.
 */
export default function CertificateBody({ model }: { model: CertificateModel }) {
  const m = model;
  const unverified = m.validity === null || m.validity === 'UNVERIFIED';
  const status = m.validity ?? 'UNVERIFIED';
  const steps = m.horizons.map((h) => ({ label: h.label, bp: unverified ? null : h.bp, binding: !unverified && h.binding.length > 1 }));
  const bindingTerms = (h: (typeof m.horizons)[number]) => (h.binding.length > 0 ? h.binding.join(' + ') : 'none');

  return (
    <DesignRoot mode={m.mode}>
      <div className="sy-cert">
        <header className="sy-cert__head container">
          <Eyebrow>
            Loss bound certificate <span className="sy-mono sy-cert__vault">{m.vaultShort}</span>
          </Eyebrow>
          <h1 className="sy-cert__h1">A bound you can recompute.</h1>
          <ModeTag mode={m.mode} />
        </header>

        {/* 1. exclusions: above the number, never below, never collapsed */}
        <ExclusionsSlab exclusions={m.exclusions} />

        {/* 2. headline + 3. status chip */}
        <section className="sy-cert__plate container" data-sy-section="headline" aria-label="Headline bound">
          <NodeFrame className="sy-cert__plate-frame">
            <div className="sy-cert__plate-main">
              <div className="sy-cert__headline" data-sy-section-part="headline">
                {unverified ? (
                  <p className="sy-cert__notcomputed">
                    <span className="sy-num-big sy-hollow-num">Not computed</span>
                    <span className="body-text-s sy-muted">
                      The certificate could not be read or recomputed, so no bound is stated.
                    </span>
                  </p>
                ) : (
                  m.headline
                )}
              </div>
              <div className="sy-cert__aside" data-sy-section-part="chip" aria-live="polite">
                {m.statusChip ?? <ValidityPill status={status} />}
                {m.asOf ? (
                  <p className="sy-mono sy-cert__asof">
                    as of block <span>{m.asOf.block}</span>
                    <br />
                    <span title={m.asOf.blockHash}>{shortHash(m.asOf.blockHash, 12, 8)}</span>
                  </p>
                ) : null}
                {m.certHash ? (
                  <p className="sy-mono sy-cert__hash" title={m.certHash}>
                    cert {shortHash(m.certHash, 12, 8)}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="sy-cert__icons" aria-hidden="true">
              <div className="sy-cert__token">
                <TallyTokenStill pose={tokenPoseFor(m.validity)} />
              </div>
              <div className="sy-cert__drum">
                <VaultDrumStill caps={[]} hollow={unverified} />
              </div>
            </div>
          </NodeFrame>
        </section>

        {/* 4. horizon table + the stair beside it */}
        <section className="sy-cert__horizons container" data-sy-section="horizons" aria-label="Bound by horizon">
          <div className="sy-cert__table-wrap">
            {m.horizonTable ?? (
              <div className="sy-cert__scroll" role="region" aria-label="Horizon table, scrollable" tabIndex={0}>
                <table className="sy-cert__table">
                  <caption className="sy-sr-only">Loss bound at each horizon, and the term that binds it</caption>
                  <thead>
                    <tr>
                      <th scope="col">Horizon</th>
                      <th scope="col">Bound</th>
                      <th scope="col">Binding term</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.horizons.map((h) => (
                      <tr key={h.label}>
                        <th scope="row" className="sy-mono">{h.label}</th>
                        <td className="sy-cert__val">{unverified ? <span className="sy-hollow-num">Not computed</span> : h.value}</td>
                        <td className="sy-mono">{unverified ? '—' : bindingTerms(h)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <Appear role="figure" className="sy-cert__steps">
            <HorizonStepsStill
              steps={steps}
              state={m.validity}
              label={unverified ? 'Horizon stair, hollow: no bound computed' : 'Loss bound at each horizon, as a stair of slabs'}
            />
          </Appear>
        </section>

        {/* 5. alarmed variant: dashed ghost, never styled as the headline */}
        {m.alarmed ? (
          <section className="sy-cert__alarmed container" data-sy-section="alarmed" aria-label="Alarmed variant">
            <div className="sy-cert__ghost sy-hatch">
              <p className="sy-mono sy-cert__ghost-l">
                If the monitor and guardian work (assumes {m.alarmed.assumes.length > 0 ? m.alarmed.assumes.join(', ') : 'the monitor assumption'})
              </p>
              <div className="sy-cert__ghost-v">{unverified ? <span className="sy-hollow-num">Not computed</span> : m.alarmed.value}</div>
              <p className="body-text-xs sy-muted">{m.alarmed.label}. This is not the headline bound.</p>
            </div>
          </section>
        ) : null}

        {/* 6. assumptions */}
        <section className="sy-cert__assume container" data-sy-section="assumptions" aria-label="Assumptions">
          <h2 className="heading-h4">Assumptions</h2>
          <PositionsList items={m.assumptions.map((a) => ({ id: a.id, title: a.text }))} />
        </section>

        {/* 7. validation */}
        <section className="sy-cert__valid container" data-sy-section="validation" aria-label="Validation">
          <h2 className="heading-h4">Validation</h2>
          {m.validation === null ? (
            <div className="sy-cert__hollow-block">
              <p className="body-text-m">Not validated for this deployment.</p>
              <p className="body-text-xs sy-muted">
                A validation block is shown only when a results file matches this code and this build.
              </p>
            </div>
          ) : (
            <dl className="sy-cert__dl">
              <dt>Trials</dt>
              <dd className="sy-num">{formatCount(m.validation.trials)}</dd>
              <dt>Violations</dt>
              <dd className="sy-num">{formatCount(m.validation.violations)}</dd>
              <dt>Upper bound on the violation rate</dt>
              <dd className="sy-mono">{m.validation.upper95}</dd>
              <dt>Tightness</dt>
              <dd className="sy-mono">{m.validation.tightness}</dd>
              <dt>Code match</dt>
              <dd>
                {m.validation.codeMatch === 'MATCH' ? (
                  <MiniTag tone="solid">Match</MiniTag>
                ) : m.validation.codeMatch === 'MISMATCH' ? (
                  <MiniTag tone="loss">Mismatch</MiniTag>
                ) : (
                  <MiniTag tone="dashed">Not checked</MiniTag>
                )}{' '}
                <span className="body-text-s">
                  {m.validation.codeMatch === 'MATCH'
                    ? 'The validation numbers are attributed to this deployed code.'
                    : m.validation.codeMatch === 'MISMATCH'
                      ? 'The deployed code differs from the code that was validated. The validation does not transfer.'
                      : 'Validated against a build; the on-chain code was not matched.'}
                </span>
              </dd>
            </dl>
          )}
        </section>

        {/* 8. verify */}
        <VerifyBlock command={m.verifyCommand} />

        {/* 9. stale diff */}
        {m.validity === 'STALE' && m.staleDiff ? <StaleDiff diff={m.staleDiff} /> : null}

        <div className="container">
          <FractureRule />
        </div>
      </div>
    </DesignRoot>
  );
}
