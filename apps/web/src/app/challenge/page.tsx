import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';
import ChallengeConsole from '@/components/challenge/ChallengeConsole';
import type { Catalog, ConsoleInitial, RecordedRow, Stats } from '@/components/challenge/types';
import { kernelCall } from '@/server/kernel-client';
import { loadAttackMatrix, loadAttackMeta, loadBundle } from '@/server/recorded';

export const metadata: Metadata = { title: `Break the Treasurer | ${BRAND.name}`, description: 'Attack a testnet sandbox treasurer. No funds, no prize. An independent oracle decides.' };
export const dynamic = 'force-dynamic';

// Live when the sandbox kernel answers (GET /v1/challenge/*, WP-32); otherwise the committed attack matrix, watermarked RECORDED.
// The page itself accepts no input: attempts are made by the client console through same-origin API routes, and attacker text
// is only ever rendered through <UntrustedText> (INV-15).
export default async function Page() {
  const meta = loadAttackMeta();
  const matrix = loadAttackMatrix();
  const ids = Array.from(new Set((matrix?.attacks ?? []).map((a) => a.attackId))).sort();
  const tiles = ids.map((id) => ({ id, caption: meta[id]?.caption ?? '' }));
  const recorded: Record<string, RecordedRow> = {};
  for (const a of matrix?.attacks ?? []) {
    if (a.target === 'symbolon') recorded[a.attackId] = { outcome: a.outcome, checksFired: a.checksFired, lossBaseUnits: a.lossBaseUnits, notes: a.notes };
  }

  const [cat, st] = await Promise.all([kernelCall<Catalog>('/v1/challenge/scenarios'), kernelCall<Stats>('/v1/challenge/stats')]);
  const live = cat.ok && cat.data.status.level !== 'L2';
  const initial: ConsoleInitial = {
    mode: live ? 'live' : 'recorded',
    catalog: live && cat.ok ? cat.data : null,
    stats: live && st.ok ? st.data : null,
    tiles: live && cat.ok ? cat.data.oneClick.map((a) => ({ id: a.attackId, caption: a.caption })) : tiles,
    recorded,
    bundleHash: loadBundle()?.bundleHash ?? null,
    brandName: BRAND.name,
  };
  return <ChallengeConsole initial={initial} />;
}
