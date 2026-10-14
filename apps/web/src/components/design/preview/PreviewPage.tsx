// Design preview page. NOT a product surface.
//
// Mount (one line, in a route file owned by the WEB lane, e.g. apps/web/src/app/(design-preview)/design-preview/[page]/page.tsx):
//     export { default } from '@/components/design/preview/PreviewPage';
//
// Guards live HERE so a mistaken mount cannot ship: it returns notFound() in production builds and on the
// challenge build profile. Every body renders with FIXTURE props (see fixtures.tsx): layout only, never a result.
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  attackLabFixture,
  certificateFixture,
  challengeFixture,
  judgeFixture,
  matrixBlockFixture,
  pilotBlockFixture,
  pilotFixture,
} from './fixtures';
import DesignLab from './DesignLab';
import JudgeBody from '../../pages/judge/JudgeBody';
import AttackLabBody from '../../pages/attack-lab/AttackLabBody';
import CertificateBody from '../../pages/certificate/CertificateBody';
import ChallengeBody from '../../pages/challenge/ChallengeBody';
import PilotBody from '../../pages/pilot/PilotBody';
import SecurityBody from '../../pages/security/SecurityBody';
import AssemblyBlock from '../../pages/home-blocks/AssemblyBlock';
import AttackMatrixBlock from '../../pages/home-blocks/AttackMatrixBlock';
import PilotStatsBlock from '../../pages/home-blocks/PilotStatsBlock';
import SpineStrip from '../../pages/home-blocks/SpineStrip';
import DesignRoot from '../DesignRoot';

export const PREVIEW_PAGES = [
  'lab',
  'judge',
  'attack-lab',
  'certificate',
  'certificate-stale',
  'certificate-unverified',
  'challenge',
  'challenge-loss',
  'challenge-normal',
  'pilot',
  'pilot-some',
  'security',
  'home',
] as const;

function enabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.NEXT_PUBLIC_PROFILE === 'challenge') return false;
  return true;
}

function render(page: string): ReactNode {
  switch (page) {
    case 'lab':
      return <DesignLab />;
    case 'judge':
      return <JudgeBody {...judgeFixture('fixture')} />;
    case 'attack-lab':
      return <AttackLabBody model={attackLabFixture()} />;
    case 'certificate':
      return <CertificateBody model={certificateFixture('VALID')} />;
    case 'certificate-stale':
      return <CertificateBody model={certificateFixture('STALE')} />;
    case 'certificate-unverified':
      return <CertificateBody model={certificateFixture('UNVERIFIED')} />;
    case 'challenge':
      return <ChallengeBody model={challengeFixture('zero')} />;
    case 'challenge-loss':
      return <ChallengeBody model={challengeFixture('loss')} />;
    case 'challenge-normal':
      return <ChallengeBody model={challengeFixture('normal')} />;
    case 'pilot':
      return <PilotBody model={pilotFixture('empty')} />;
    case 'pilot-some':
      return <PilotBody model={pilotFixture('some')} />;
    case 'security':
      return <SecurityBody model={securityFixture()} />;
    case 'home':
      return (
        <DesignRoot mode="fixture">
          <AssemblyBlock />
          <AttackMatrixBlock {...matrixBlockFixture()} />
          <PilotStatsBlock {...pilotBlockFixture()} />
          <SpineStrip />
        </DesignRoot>
      );
    default:
      return null;
  }
}

function securityFixture() {
  return {
    title: 'Attack us, in good faith.',
    toc: [
      { id: 'scope', title: 'Scope' },
      { id: 'rules', title: 'Rules of engagement' },
      { id: 'claims', title: 'What we claim' },
      { id: 'contact', title: 'Contact' },
    ],
    prose: (
      <>
        <h2 id="scope">Scope</h2>
        <p>Fixture prose. The real page is rendered from the lane&apos;s static markdown; this only shows the type.</p>
        <ul>
          <li>The kernel, the vault and the web app are in scope.</li>
          <li>Anything that moves real funds is out of scope.</li>
        </ul>
        <h2 id="rules">Rules of engagement</h2>
        <p>Fixture prose with <code>inline code</code> and a block:</p>
        <pre><code>{'pnpm sec:local\npnpm claims:lint'}</code></pre>
        <h2 id="claims">What we claim</h2>
        <p>Fixture prose.</p>
        <h2 id="contact">Contact</h2>
        <p>Fixture prose.</p>
      </>
    ),
    claims: {
      we: <p>We state a bound, its assumptions and its exclusions, and invite attack.</p>,
      wedont: <p>We do not state that the system cannot lose money. Fixture text.</p>,
    },
    contact: <p>Contact slot (lane).</p>,
  };
}

export default async function PreviewPage({ params }: { params?: Promise<{ page?: string }> }) {
  if (!enabled()) notFound();
  const { page } = (await params) ?? {};
  if (!page || !(PREVIEW_PAGES as readonly string[]).includes(page)) {
    return (
      <main className="container">
        <h1>Design preview</h1>
        <ul>
          {PREVIEW_PAGES.map((p) => (
            <li key={p}>
              <a href={`/design-preview/${p}`}>{p}</a>
            </li>
          ))}
        </ul>
      </main>
    );
  }
  return <main>{render(page)}</main>;
}
