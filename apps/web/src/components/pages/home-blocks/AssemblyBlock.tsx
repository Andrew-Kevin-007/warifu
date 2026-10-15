'use client';

import { useEffect, useRef, useState } from 'react';
import ReceiptSealStill from '../../design/stills/ReceiptSealStill';
import TallyTokenStill from '../../design/stills/TallyTokenStill';
import { clamp01, windowed } from '../../design/runtime/format';
import { assemblyPose } from '../../design/runtime/states';
import type { AssemblyProps } from './types';

const STEPS: { title: string; text: string }[] = [
  {
    title: 'The agent proposes',
    text: 'Invoice text becomes a suggested payee, amount and evidence set. The proposal cannot authorize its own payment.',
  },
  {
    title: 'The kernel checks',
    text: 'Deterministic rules check evidence, signed payment terms, policy, balances and history before returning a verdict.',
  },
];

function lastStep(fit: 'match' | 'mismatch' | 'unknown'): { title: string; text: string } {
  if (fit === 'match') {
    return { title: 'The vault releases', text: 'A valid attestation gates the release. The on-chain event anchors a receipt that can be checked later.' };
  }
  if (fit === 'mismatch') {
    return { title: 'The vault refuses', text: 'The halves do not fit, so nothing moves. The refusal leaves a receipt too.' };
  }
  return { title: 'Nothing is claimed here', text: 'This is a drawing of the flow, not a decision. No payment has been checked on this page.' };
}

/**
 * "From invoice to receipt": the token assembles as you scroll. Progressive:
 * - no JS, reduced motion or narrow screens: three static plates showing the final pose;
 * - desktop with motion: a 220 vh section with a sticky stage; scroll progress (passive listener + rAF, no wheel
 *   capture, no pinning library) drives --sy-gap on the section and an integer step.
 * The halves only seat when `fit === 'match'`. The default is `unknown`: hollow halves and a hollow seal, so the
 * decorative home token never asserts a fit nobody checked.
 */
export default function AssemblyBlock({ fit = 'unknown', checks, receiptHash = null }: AssemblyProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [live, setLive] = useState(false);
  const [step, setStep] = useState(2);
  const [lit, setLit] = useState(checks ? checks.length : 0);
  const [sealed, setSealed] = useState(true);
  const [pose, setPose] = useState(assemblyPose(fit, { approach: 1, scan: 1, seat: 1 }));
  const last = lastStep(fit);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const desktop = window.matchMedia('(min-width: 1000px)').matches;
    if (reduce || !desktop) return;
    setLive(true);
    let raf = 0;
    const total = checks ? checks.length : 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const span = Math.max(1, r.height - window.innerHeight);
      const p = clamp01(-r.top / span);
      const w = { approach: windowed(p, 0, 0.3), scan: windowed(p, 0.3, 0.62), seat: windowed(p, 0.62, 0.85) };
      const seal = windowed(p, 0.85, 1);
      const gap = 1 - 0.5 * w.approach - 0.35 * w.scan - 0.15 * w.seat;
      el.style.setProperty('--sy-gap', gap.toFixed(3));
      setStep(p < 0.3 ? 0 : p < 0.62 ? 1 : 2);
      setLit(total === 0 ? 0 : Math.min(total, Math.floor(w.scan * total + 0.0001)));
      setSealed(seal >= 1);
      setPose(assemblyPose(fit, w));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [fit, checks]);

  const sealState = fit === 'match' && receiptHash ? 'sealed' : 'hollow';
  const staticPose = assemblyPose(fit, { approach: 1, scan: 1, seat: 1 });

  return (
    <section ref={ref} className="sy-asm" data-live={live ? 'true' : undefined} data-fit={fit} aria-labelledby="sy-asm-h" id="attack-sequence">
      <div className="sy-asm__stage container">
        <header className="sy-asm__head">
          <p className="sy-eyebrow body-text-s">One bounded flow</p>
          <h2 id="sy-asm-h" className="heading-h1 gradient-text-black">From invoice to receipt.</h2>
        </header>

        <div className="sy-asm__grid">
          <ol className="sy-asm__steps">
            {[...STEPS, last].map((s, i) => (
              <li key={s.title} className="sy-asm__step" data-active={live ? (step === i ? 'true' : undefined) : undefined}>
                <span className="sy-mono sy-asm__n">{String(i + 1).padStart(2, '0')}</span>
                <p className="sy-asm__title">{s.title}</p>
                <p className="body-text-s sy-asm__text">{s.text}</p>
                {i === 1 && checks && checks.length > 0 ? (
                  <ul className="sy-asm__ticks" aria-label="Checks">
                    {checks.map((c, k) => (
                      <li key={c.id} className="sy-asm__tick" data-status={c.status} data-lit={!live || k < lit ? 'true' : undefined}>
                        <span className="sy-mono">{c.id}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>

          <div className="sy-asm__object">
            <div className="sy-asm__token">
              <TallyTokenStill
                pose={live ? pose : staticPose}
                scrub={live}
                scanLine={live && step === 1}
                label={
                  fit === 'match'
                    ? 'Tally token: the proposal half and the engagement half seat'
                    : fit === 'mismatch'
                      ? 'Tally token: the halves do not fit'
                      : 'Tally token, hollow: no fit has been checked'
                }
              />
            </div>
            <div className="sy-asm__seal" data-on={!live || sealed ? 'true' : undefined}>
              <ReceiptSealStill hash={receiptHash} state={sealState} stamp={live && sealed} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
