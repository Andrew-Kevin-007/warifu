import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Chip, PageFrame, Section, SourceBanner } from '@/components/product/PageFrame';
import { loadAttackMatrix, loadAttackMeta, loadBundle } from '@/server/recorded';

export const metadata: Metadata = {
  title: `Judge path | ${BRAND.name}`,
  description: 'A five-card path through the evidence: watch an attack, verify a receipt, recompute a bound, try to break it, see real use.',
};
export const dynamic = 'force-dynamic';

const CHALLENGE_URL = process.env.NEXT_PUBLIC_CHALLENGE_URL ?? null;

export default function Page() {
  const m = loadAttackMatrix();
  const meta = loadAttackMeta();
  const bundle = loadBundle();
  const sym = m?.attacks.find((a) => a.attackId === 'ATK-10' && a.target === 'symbolon');
  const b1 = m?.attacks.find((a) => a.attackId === 'ATK-10' && a.target === 'b1');
  const symTotals = m?.totals.find((t) => t.target === 'symbolon');
  const b1Totals = m?.totals.find((t) => t.target === 'b1');
  const sandboxVault = process.env.NEXT_PUBLIC_SANDBOX_VAULT ?? null;

  return (
    <PageFrame
      eyebrow="Judge path"
      title="Five cards, about five minutes"
      lede="Each card opens something you can check without logging in. Nothing on this path accepts free-form input; anything attackable lives on a separate origin."
    >
      <SourceBanner source="RECORDED" note={<>Cards 1 and 3 read the committed replay bundle <span className="sy-mono">{bundle?.bundleHash ?? 'n/a'}</span>.</>} />

      <Section title="The path">
        <div className="sy-grid">
          <article className="sy-card">
            <p className="body-text-s">1</p>
            <h3 className="heading-h6">Watch an attack get the agent fooled and the money not move</h3>
            <p className="body-text-s" style={{ marginTop: 8 }}>
              {meta['ATK-10']?.caption ?? 'ATK-10 from the attack lab.'}
            </p>
            {sym && b1 ? (
              <ul className="sy-list" style={{ marginTop: 8 }}>
                <li>{BRAND.name}: <Chip tone="pass">{sym.outcome}</Chip> checks fired <span className="sy-mono">{sym.checksFired.join(' ') || 'none'}</span>; loss {sym.lossBaseUnits} base units.</li>
                <li>B1 pattern reimplementation (ours): <Chip tone={b1.outcome === 'LOSS' ? 'fail' : 'pass'}>{b1.outcome}</Chip>; loss {b1.lossBaseUnits} base units.</li>
              </ul>
            ) : (
              <p className="body-text-s" style={{ marginTop: 8 }}>ATK-10 is not in the recorded matrix.</p>
            )}
            <p style={{ marginTop: 12 }}><Link className="sy-btn" href="/attack-lab">Open the attack lab</Link></p>
          </article>

          <article className="sy-card">
            <p className="body-text-s">2</p>
            <h3 className="heading-h6">Verify a receipt yourself</h3>
            <p className="body-text-s" style={{ marginTop: 8 }}>
              Your browser recomputes the hash, recovers the signer, reads the kernel signer from the vault and looks for the Released event.
              {bundle && bundle.receipts.length === 0 ? ' The committed bundle holds no receipts yet, so paste or enter a hash from a run.' : ''}
            </p>
            <p style={{ marginTop: 12 }}><Link className="sy-btn" href="/audit">Open the verifier</Link></p>
          </article>

          <article className="sy-card">
            <p className="body-text-s">3</p>
            <h3 className="heading-h6">Recompute the loss bound</h3>
            <p className="body-text-s" style={{ marginTop: 8 }}>
              Exclusions first, then the bound, then the assumptions. The command line verifier recomputes it from the chain.
            </p>
            <p style={{ marginTop: 12 }}>
              <Link className="sy-btn" href={sandboxVault ? `/certificate/${sandboxVault}` : '/certificate'}>Open the certificate</Link>{' '}
              <Link className="sy-btn sy-btn--secondary" href="/blast-radius">Try your own limits</Link>
            </p>
          </article>

          <article className="sy-card">
            <p className="body-text-s">4</p>
            <h3 className="heading-h6">Try to break it</h3>
            <p className="body-text-s" style={{ marginTop: 8 }}>
              The challenge runs on its own origin with its own vault, signer and keys. Attack traffic is never counted as customer traffic.
            </p>
            <p style={{ marginTop: 12 }}>
              {CHALLENGE_URL !== null ? (
                <a className="sy-btn" href={CHALLENGE_URL} rel="noopener noreferrer">Open the challenge</a>
              ) : (
                <Chip tone="muted">CHALLENGE NOT DEPLOYED</Chip>
              )}
            </p>
          </article>

          <article className="sy-card">
            <p className="body-text-s">5</p>
            <h3 className="heading-h6">See the real users</h3>
            <p className="body-text-s" style={{ marginTop: 8 }}>Pilot figures count pilot tenants only, with explorer links per payment when there are any.</p>
            <p style={{ marginTop: 12 }}><Link className="sy-btn" href="/pilot">Open the pilot page</Link></p>
          </article>
        </div>
      </Section>

      {symTotals && b1Totals ? (
        <Section title="Headline figures from the committed run">
          <div className="sy-card">
            <p>
              {BRAND.name}: {symTotals.lossTrials} loss trials of {symTotals.trials} (upper 95 % bound {symTotals.lossRate.upper95.toFixed(4)}, {symTotals.lossRate.upper95Method}). B1: {b1Totals.lossTrials} of {b1Totals.trials}.{' '}
              <Chip tone="warn">SIMULATED</Chip>
            </p>
            <p className="body-text-s" style={{ marginTop: 8 }}>
              Calculated from the committed harness output and empirically tested only in the harness&apos;s unit mode. Trials of one fixture are not independent, so the bound is optimistic. See the attack lab for assumptions and exclusions.
            </p>
          </div>
        </Section>
      ) : null}

      <Section title="What this does not do">
        <ul className="sy-list">
          <li>It does not judge whether the work being paid for was good.</li>
          <li>It does not cover compromise of the owner key or the key that can change the policy.</li>
          <li>It does not promise availability: a compromised key can use up limits to block legitimate payments.</li>
          <li>X this is hackathon-stage software on a testnet.</li>
          <li>Planner figures are SIMULATED, replay content is RECORDED, and the hold-out set has not been run.</li>
        </ul>
      </Section>
    </PageFrame>
  );
}
