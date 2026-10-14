import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import SiteShell from '@/components/SiteShell';
import Hero from '@/components/home/Hero';
import SectionGateway from '@/components/home/SectionGateway';
import SectionMarket from '@/components/home/SectionMarket';
import SectionNativeCurrency from '@/components/home/SectionNativeCurrency';
import SectionAgentFrameworks from '@/components/home/SectionAgentFrameworks';
import SectionOneClickDeployment from '@/components/home/SectionOneClickDeployment';
import SectionPoweredBy from '@/components/home/SectionPoweredBy';
import SectionFeaturesGrid from '@/components/home/SectionFeaturesGrid';
import PageGrid from '@/components/home/PageGrid';

export const metadata: Metadata = {
  title: `${BRAND.name} | Evidence-Gated Agent Treasury on Arc`,
  description: `${BRAND.name} checks evidence, signed payment terms, policy and history before an Arc vault can release USDC. Agent proposals stay advisory; releases leave verifiable receipts.`,
};

export default function Page() {
  return (
    <SiteShell>
      <main className="relative z-5">
        <Hero />
        <SectionGateway />
        <SectionMarket />
        <SectionNativeCurrency />
        <SectionAgentFrameworks />
        <SectionOneClickDeployment />
        <SectionPoweredBy />
        <SectionFeaturesGrid />
        <PageGrid />
      </main>
    </SiteShell>
  );
}
