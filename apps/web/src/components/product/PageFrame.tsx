import type { ReactNode } from 'react';
import SiteShell from '@/components/SiteShell';
import DesignRoot from '@/components/design/DesignRoot';
import { Eyebrow, FractureRule } from '@/components/design/primitives/Layout';

// The frame of every page that is not one of the designed bodies (audit, blast radius, dashboard, engagements, intents, sign): the same
// white plate, large quiet type and fracture rule as the designed pages, so the whole site reads as one object.
export function PageFrame({ eyebrow, title, lede, children }: { eyebrow?: string; title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <SiteShell>
      <DesignRoot mode="live">
        <main className="sy-page-d relative z-5">
          <div className="container">
            <header className="sy-page-d__head">
              {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
              <h1 className="sy-page-d__h1">{title}</h1>
              {lede ? <p className="body-text-l sy-page-d__lede">{lede}</p> : null}
            </header>
            <FractureRule />
            <div className="sy-page-d__body">{children}</div>
          </div>
        </main>
      </DesignRoot>
    </SiteShell>
  );
}

export function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="sy-section" id={id}>
      <h2 className="sy-section__h">{title}</h2>
      {children}
    </section>
  );
}

export type ChipTone = 'pass' | 'fail' | 'warn' | 'muted' | 'plain';
export function Chip({ tone = 'plain', children }: { tone?: ChipTone; children: ReactNode }) {
  const cls = tone === 'plain' ? 'sy-chip' : `sy-chip sy-chip--${tone}`;
  return <span className={cls}>{children}</span>;
}

/** Visible provenance banner: RECORDED (committed replay bundle) or LIVE. */
export function SourceBanner({ source, note }: { source: 'RECORDED' | 'LIVE'; note?: ReactNode }) {
  if (source === 'LIVE') return null;
  return (
    <div className="sy-banner" role="note">
      <strong>RECORDED.</strong> This page is rendered from the committed replay bundle, not from a live service.{' '}
      {note}
    </div>
  );
}

export function Simulated({ children }: { children: ReactNode }) {
  return <Chip tone="warn">{children ?? 'SIMULATED'}</Chip>;
}
