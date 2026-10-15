import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EXCLUSIONS } from '@symbolon/blast-radius/lbc';
import { Chip, PageFrame, Section } from '@/components/product/PageFrame';

export const metadata: Metadata = {
  title: `Docs | ${BRAND.name}`,
  description: `What ${BRAND.name} is, how a payment flows, the kernel checks, and how to verify a receipt or a certificate yourself.`,
};

const CHECKS: [string, string, string][] = [
  ['K-01', 'STRICT_SCHEMA', 'The intent must parse exactly: no extra fields, no binary, bounded text.'],
  ['K-02', 'PRECISION_EXACT', 'Amounts are read as exact integers in base units; ambiguous separators go to a human, rounding is refused.'],
  ['K-03', 'DOC_TYPE_SIGN', 'Only invoices are payable; credit notes and statements are not.'],
  ['K-04', 'IDEMPOTENCY_DEDUPE', 'The same intent, a near-duplicate or an already paid milestone is a replay or an escalation.'],
  ['K-05', 'ENGAGEMENT_BINDING', 'There must be an active signed engagement and a matching milestone in its window.'],
  ['K-06', 'PAYEE_BINDING', 'The payee address comes from the signed engagement; an address printed on an invoice never changes it.'],
  ['K-07', 'CURRENCY_DECIMALS', 'Currency and decimals must match the vault token; absurd scales are rejected.'],
  ['K-08', 'AMOUNT_CONFORMANCE', 'The amount must equal the milestone amount exactly; overpayment is rejected, underpayment escalates.'],
  ['K-09', 'EVIDENCE_MATCH', 'Evidence the kernel collected itself must match the milestone requirement; missing evidence holds the payment.'],
  ['K-10', 'EXTRACTION_CONSENSUS', 'Two independent extractions must agree on payee, amount and references.'],
  ['K-11', 'INSTRUCTION_CHANGE_HEURISTIC', 'Text that tries to change payment instructions is flagged for a human.'],
  ['K-12', 'AUTHORITY_ENVELOPE', 'Per-payment, daily and velocity limits, human gates and the escalation budget.'],
  ['K-13', 'COUNTERPARTY_SCREEN', 'Optional counterparty screening; pending or disabled screening is visible in the receipt.'],
  ['K-14', 'LIQUIDITY_AND_TIMING', 'Vault liquidity, signed payment terms, the discount window and the plan timing.'],
  ['K-15', 'RECONCILIATION_WITNESS', 'After settlement, on-chain state is compared with what the kernel decided.'],
  ['K-16', 'CIRCUIT_BREAKER', 'A tripped breaker or a paused vault holds everything.'],
];

export default function Page() {
  return (
    <PageFrame
      eyebrow="Docs"
      title={`How ${BRAND.name} works`}
      lede="Do not trust the agent. Bound it. Prove it. Invite attack. This page is a short map of the system and of the ways you can check it without trusting us."
    >
      <Section title="What it is">
        <p>
          {BRAND.name} is an evidence-gated treasury for agent-run payments on Arc. An AI agent may read an invoice and propose a payment. A deterministic kernel decides.
          A vault contract enforces hard limits even if the kernel&apos;s signing key is stolen. Every decision leaves a signed receipt you can verify.
        </p>
      </Section>

      <Section title="The flow">
        <ol className="sy-list" style={{ listStyle: 'decimal' }}>
          <li><strong>The agent proposes.</strong> Extraction output is advisory text; it cannot release funds and is shown collapsed and labelled advisory.</li>
          <li><strong>The kernel checks.</strong> Sixteen checks run against the signed engagement, kernel-collected evidence and the policy. The verdict is RELEASE, HOLD, ESCALATE, REJECT or REPLAY. No model output is a release condition.</li>
          <li><strong>The vault releases.</strong> The contract verifies the kernel&apos;s attestation, the payee binding and its own caps. A stolen signer is still bounded by the vault.</li>
          <li><strong>A receipt is written.</strong> The receipt is hashed, signed and anchored by the vault&apos;s Released event.</li>
        </ol>
      </Section>

      <Section title="The checks">
        <div className="sy-table-wrap">
          <table className="sy-table">
            <thead><tr><th>ID</th><th>Name</th><th>What it does</th></tr></thead>
            <tbody>
              {CHECKS.map(([id, name, text]) => (
                <tr key={id}><td className="sy-mono">{id}</td><td className="sy-mono">{name}</td><td>{text}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Verify a receipt">
        <p>In your browser: open <Link href="/audit">the receipt verifier</Link>. On the command line:</p>
        <pre className="sy-pre">pnpm verify-receipt &lt;receipt.json | 0xhash&gt; --vault &lt;vault&gt; --rpc &lt;your-own-rpc-url&gt;</pre>
        <p className="body-text-s">Exit code 0 verified, 1 not verified, 2 usage or input error. The kernel signer is read from the vault, not from the receipt.</p>
      </Section>

      <Section title="Verify a certificate">
        <pre className="sy-pre">pnpm lbc verify &lt;vault&gt; --rpc &lt;your-own-rpc-url&gt; --artifact &lt;foundry-artifact.json&gt;</pre>
        <ul className="sy-list">
          <li><span className="sy-mono">0</span> VALID: your recomputation agrees with the certificate.</li>
          <li><span className="sy-mono">10</span> STALE: on-chain configuration changed since it was built; the diff says what.</li>
          <li><span className="sy-mono">20</span> UNVERIFIED: the chain could not be read or the inputs could not be checked.</li>
        </ul>
        <p className="body-text-s">A certificate is a calculation under stated assumptions, empirically tested; it is not a proof. <Link href="/certificate">Open one</Link>.</p>
      </Section>

      <Section title="Threat models and exclusions">
        <ul className="sy-list">
          <li><strong>T1</strong> a forged or misleading document or evidence: the kernel and its evidence collectors are the defence.</li>
          <li><strong>T2</strong> a compromised model or prompt: no loss path, since model output cannot release funds; liveness can still be disrupted.</li>
          <li><strong>T3</strong> a stolen kernel signer: the vault caps, payee binding and rings bound what can leave per time horizon.</li>
        </ul>
        <p style={{ marginTop: 12 }}>What the bound does not cover:</p>
        <ul className="sy-list">
          {EXCLUSIONS.map((x) => (
            <li key={x.id}><span className="sy-mono">{x.id}</span> {x.text}</li>
          ))}
        </ul>
      </Section>

      <Section title="Status and limits">
        <ul className="sy-list">
          <li><Chip tone="warn">TESTNET</Chip> The public challenge and the sandbox vault run on testnet only, hold no real funds and offer no prize. Attack traffic is never counted as traction.</li>
          <li>The contracts and the code have not had an independent security review. Contract caps are deliberately tiny.</li>
          <li>Planner figures are SIMULATED; replayed content is RECORDED; B1 is our reimplementation of a pattern, not Circle&apos;s code; B0 is the vendored decision path of Circle&apos;s sample with only network edges stubbed.</li>
          <li>Responsible disclosure and testing terms are on the <Link href="/security">security page</Link>.</li>
        </ul>
      </Section>
    </PageFrame>
  );
}
