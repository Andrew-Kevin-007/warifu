import { Chip, Section } from './PageFrame';
import { SignEngagementPanel } from '@/wallet/SignEngagementPanel';

export interface EngagementViewData {
  engagementId: string;
  status: string;
  termsHash: string;
  ownerSigned: boolean;
  payeeSigned: boolean;
  submittedTx: string | null;
  registeredTx: string | null;
  registrationError: string | null;
  typedData: unknown;
  digest: string | null;
}

export function EngagementStatus({ e, fixedRole }: { e: EngagementViewData; fixedRole: 'owner' | 'payee' | null }) {
  const open = e.typedData !== null && typeof e.typedData === 'object';
  return (
    <>
      <Section title="Status">
        <div className="sy-table-wrap">
          <table className="sy-table">
            <tbody>
              <tr><th>Engagement</th><td className="sy-mono">{e.engagementId}</td></tr>
              <tr><th>Status</th><td><Chip tone={e.status === 'ACTIVE' ? 'pass' : 'warn'}>{e.status}</Chip></td></tr>
              <tr><th>Owner signature</th><td>{e.ownerSigned ? <Chip tone="pass">signed</Chip> : <Chip tone="muted">missing</Chip>}</td></tr>
              <tr><th>Payee signature</th><td>{e.payeeSigned ? <Chip tone="pass">signed</Chip> : <Chip tone="muted">missing</Chip>}</td></tr>
              <tr><th>Terms hash</th><td className="sy-mono">{e.termsHash}</td></tr>
              <tr><th>Registration tx</th><td className="sy-mono">{e.registeredTx ?? e.submittedTx ?? 'not submitted'}</td></tr>
              {e.registrationError !== null ? <tr><th>Registration error</th><td>{e.registrationError}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Section>
      {open ? (
        <Section title="Sign">
          <SignEngagementPanel engagementId={e.engagementId} termsHash={e.termsHash} typedData={e.typedData as { domain: { chainId: number | string }; message: Record<string, unknown> }} digest={e.digest} fixedRole={fixedRole} />
        </Section>
      ) : null}
    </>
  );
}
