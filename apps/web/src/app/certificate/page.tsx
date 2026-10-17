import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { BRAND } from '@/lib/brand';
import CertificateBody from '@/components/pages/certificate/CertificateBody';
import { CertificateLookup } from '@/components/product/CertificateLookup';
import { certificateModel } from '@/server/certificate-model';
import { isAddress } from '@/server/public-data';

export const metadata: Metadata = { title: `Loss bound certificate | ${BRAND.name}` };
export const dynamic = 'force-dynamic';

// With a sandbox vault configured this is its certificate; without one it is the honest empty state: exclusions, no number.
export default function Page() {
  const vault = process.env.NEXT_PUBLIC_SANDBOX_VAULT ?? '';
  if (isAddress(vault)) redirect(`/certificate/${vault}`);
  return (
    <>
      <CertificateBody model={certificateModel({ vault: 'no vault configured', mode: 'recorded', cert: null, view: null })} />
      <section className="container" style={{ paddingBottom: 96 }} aria-label="Open a certificate">
        <h2 className="heading-h4">Open a certificate by vault address</h2>
        <CertificateLookup defaultVault="" />
      </section>
    </>
  );
}
