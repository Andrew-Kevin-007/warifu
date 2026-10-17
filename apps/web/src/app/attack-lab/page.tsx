import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';
import AttackLabBody from '@/components/pages/attack-lab/AttackLabBody';
import { attackLabModel } from '@/server/attack-lab-model';
import { loadAttackMatrix, loadAttackMeta } from '@/server/recorded';

export const metadata: Metadata = {
  title: `Attack lab | ${BRAND.name}`,
  description: `Twenty-four attacks against a vendored sample path, two reimplemented baselines and ${BRAND.name}, judged by an independent oracle.`,
};
export const dynamic = 'force-dynamic';

// RECORDED: rendered from the committed attack matrix (the harness output), never from a live service. The mode tag and the
// limitations list travel with the numbers; the body forces SIMULATED while the file says no model output was recorded.
export default function Page() {
  const m = loadAttackMatrix();
  if (m === null) {
    return (
      <main className="container" style={{ padding: '120px 0' }}>
        <h1 className="heading-h2">Attack matrix unavailable</h1>
        <p className="body-text-l">No recorded attack matrix is available in this deployment. Nothing is shown rather than a made-up result.</p>
      </main>
    );
  }
  return <AttackLabBody model={attackLabModel(m, loadAttackMeta())} />;
}
