import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import SiteShell from '@/components/SiteShell';
import SectionManifesto from '@/components/about/SectionManifesto';
import SectionAcceleration from '@/components/about/SectionAcceleration';
import SectionCareers from '@/components/about/SectionCareers';
import SectionName from '@/components/about/SectionName';

export const metadata: Metadata = {
  title: `About ${BRAND.name} | Agent Treasury Controls on Arc`,
  description: `Why ${BRAND.name} keeps AI payment proposals advisory, checks evidence and signed terms in a deterministic kernel, and enforces limits with an Arc vault.`,
};

export default function Page() {
  return (
    <SiteShell>
      <main className="relative z-5">
        <SectionManifesto />
        <SectionAcceleration />
        <SectionCareers />
        <SectionName />
      </main>
    </SiteShell>
  );
}
