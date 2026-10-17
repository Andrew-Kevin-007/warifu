'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { gsap } from 'gsap';
import { useMediaQuery } from 'react-responsive';
import Img from '@/components/ui/Img';
import HeroWave from '@/components/home/HeroWave';
import HeroGrid from '@/components/home/HeroGrid';

const slides = [
  {
    title: 'Poison the invoice',
    text: 'Hide a changed payout address inside a supplier invoice.',
    button: { text: 'More details ->', link: '/judge' },
    main: { src: '/media/figure-main-ai-console.c850f2f4.png', width: 660, height: 660 },
    gray: { src: '/media/figure-main-ai-console-gray.7e22a8bf.png', width: 734, height: 750 },
    video: '/videos/ai_console.webm',
  },
  {
    title: 'The agent says PAY',
    text: 'Extraction creates a payment proposal. Its output cannot authorize a release.',
    button: { text: 'More details ->', link: '/attack-lab' },
    main: { src: '/media/figure-main-ai-hub.a0ef6773.png', width: 660, height: 660 },
    gray: { src: '/media/figure-main-ai-hub-gray.ccf64da7.png', width: 734, height: 750 },
    video: '/videos/ai_hub.webm',
  },
  {
    title: 'The kernel decides',
    text: 'Checks compare evidence, signed terms, policy, and payment history.',
    button: { text: 'More details ->', link: '/blast-radius' },
    main: { src: '/media/figure-main-search.590a6d8f.png', width: 660, height: 660 },
    gray: { src: '/media/figure-main-search-gray.35201136.png', width: 734, height: 750 },
    video: '/videos/search_engine.webm',
  },
  {
    title: 'Measure the blast radius',
    text: 'Recompute the maximum loss from public vault state and stated assumptions.',
    button: { text: 'More details ->', link: '/certificate' },
    main: { src: '/media/figure-main-staking.39cb3742.png', width: 660, height: 660 },
    gray: { src: '/media/figure-main-staking-gray.c33a1041.png', width: 734, height: 750 },
    video: '/videos/staking.webm',
  },
];

const pagination = [
  { icon: '/media/ai-console.9c20efbd.svg', alt: 'Poisoned invoice' },
  { icon: '/media/ai-hub.d59be836.svg', alt: 'Agent proposal' },
  { icon: '/media/symbolon-search.svg', alt: 'Kernel decision' },
  { icon: '/media/staking.dfee9c51.svg', alt: 'Blast Radius' },
];

// webm playback is not available in Safari, fall back to the still there
function canPlayWebm() {
  if (typeof document === 'undefined') return false;
  return document.createElement('video').canPlayType('video/webm') !== '';
}

function Figures({
  content,
  isHovered,
  setIsHovered,
  setHideSquares,
  activeSlide,
}: {
  content: (typeof slides)[number];
  isHovered: boolean;
  setIsHovered: (v: boolean) => void;
  setHideSquares: (v: boolean) => void;
  activeSlide: number;
}) {
  const isMobile = useMediaQuery({ query: '(max-width: 999px)' });
  const isDesktop = useMediaQuery({ query: '(min-width: 1000px)' });
  // react-responsive reports false on the server, mirror the original's post-mount state
  const [mobile, setMobile] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [webm, setWebm] = useState(false);
  useEffect(() => setMobile(isMobile), [isMobile]);
  useEffect(() => setDesktop(isDesktop), [isDesktop]);
  useEffect(() => setWebm(canPlayWebm()), []);

  const main = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const [grayClass, setGrayClass] = useState('opacity-0 duration-200');

  useEffect(() => {
    if (isHovered) {
      const t = setTimeout(() => setGrayClass('opacity-100 duration-700'), 500);
      return () => clearTimeout(t);
    }
    setGrayClass('opacity-0 duration-200');
  }, [isHovered]);

  // the main figure leans toward the cursor while it is close, then springs back
  useEffect(() => {
    const el = main.current;
    const hero = document.querySelector('.hero');
    if (!el || !hero) return;
    let near = false;

    const onMove = (e: Event) => {
      const ev = e as MouseEvent;
      const factor = near ? 0.6 : 0.4;
      const mouse = { x: ev.clientX, y: ev.clientY - window.scrollY };
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const r = el.getBoundingClientRect();
      const center = { x: r.left + w / 2, y: r.top + h / 2 };
      const dx = mouse.x - center.x;
      const dy = mouse.y - center.y;
      const inside = Math.sqrt(dx * dx + dy * dy) < w * factor;

      if (inside) {
        near = true;
        gsap.to(el, { duration: 1.7, x: 0.3 * dx, y: 0.3 * dy, rotation: 0.05 * dx, ease: 'power2.out' });
        [left.current, right.current].forEach((t) =>
          gsap.to(t, { duration: 3.7, x: 0.2 * dx, y: 0.2 * dy, rotation: 0.03 * dx, ease: 'power2.out' }),
        );
      } else if (near) {
        const back = { x: 0, y: 0, scale: 1, rotation: 0, ease: 'elastic.out(1.2, 0.4)' };
        gsap.to(el, { duration: 1.7, ...back });
        gsap.to(left.current, { duration: 3.7, ...back });
        gsap.to(right.current, { duration: 3.7, ...back });
        near = false;
      }
    };

    hero.addEventListener('mousemove', onMove);
    return () => hero.removeEventListener('mousemove', onMove);
  }, []);

  const grayImg = (
    <Img
      src={content.gray.src}
      alt={content.title}
      width={content.gray.width}
      height={content.gray.height}
      className={`w-full transition-all ease-[cubic-bezier(0.25,0.1,0.25,1)] ${grayClass}`}
    />
  );
  const mainImg = (
    <Img src={content.main.src} alt={content.title} width={content.main.width} height={content.main.height} className="w-full" />
  );

  return (
    <div className="hero__figures relative mx-auto max-w-[999px]">
      <div
        className="hero__figures-left pointer-events-none absolute left-0 top-[130px] z-1 w-[367px] select-none"
        ref={left}
      >
        {grayImg}
      </div>
      <div
        className="hero__figures-main absolute left-1/2 top-[204px] z-5 w-[330px] -translate-x-1/2 select-none mix-blend-normal"
        ref={main}
        onMouseEnter={() => {
          setIsHovered(true);
          setHideSquares(false);
        }}
        onMouseLeave={() => {
          setIsHovered(false);
          setHideSquares(true);
        }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={activeSlide}
            initial={{ opacity: 0, y: 0 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 0 }}
            transition={{ duration: 0.3 }}
            className="hero__figures-wrapper"
          >
            {mobile && mainImg}
            {desktop && webm && (
              <video className="w-full" autoPlay muted>
                <source src={content.video} type="video/webm" />
              </video>
            )}
            {desktop && !webm && mainImg}
          </motion.div>
        </AnimatePresence>
      </div>
      <div
        className="hero__figures-right pointer-events-none absolute right-0 top-[103px] z-1 w-[351px] select-none"
        ref={right}
      >
        {grayImg}
      </div>
    </div>
  );
}

export default function Hero() {
  const [active, setActive] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [hideSquares, setHideSquares] = useState(true);
  const [cloudsClass, setCloudsClass] = useState('');
  const slide = slides[active];

  // the cloud fades out while a figure is hovered
  useEffect(() => {
    if (isHovered) {
      const t = setTimeout(() => setCloudsClass('opacity-0'), 500);
      return () => clearTimeout(t);
    }
    setCloudsClass('');
  }, [isHovered]);

  return (
    <section className="hero relative pb-xl pt-[170px] lg:pt-[570px] overflow-hidden">
      <div className="container-wide">
        <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 scale-50 md:pointer-events-auto md:scale-75 lg:scale-100">
          <div className="hero__wrapper absolute left-1/2 top-[57px] mx-auto h-full w-[1350px] -translate-x-1/2 lg:top-0">
            <div className="hero__label pointer-events-none absolute left-1/2 top-[120px] z-[8] flex -translate-x-1/2 scale-150 items-center gap-[10px] lg:top-[104px] lg:scale-100">
              <p className="body-text-xs">Built on</p>
              <img
                src="/assets/arc-logo-transparent.png"
                alt="Arc"
                width={48}
                height={16}
                className="block h-4 w-12 shrink-0 object-contain"
              />
            </div>
            <div
              className={`hero__clouds pointer-events-none absolute left-1/2 top-[-120px] z-1 -translate-x-1/2 transition-all duration-500 ${cloudsClass}`}
            >
              <HeroWave />
            </div>
            <HeroGrid isHovered={isHovered} hideSquares={hideSquares} />
            <Figures
              content={slide}
              isHovered={isHovered}
              setIsHovered={setIsHovered}
              setHideSquares={setHideSquares}
              activeSlide={active}
            />
          </div>
        </div>
        <div className="hero__info relative mx-auto flex max-w-[1234px] flex-col gap-lg pt-[200px] md:pt-[370px] md:text-center lg:flex-row lg:justify-between lg:pt-0 lg:text-left">
          <div className="hero__info-left flex flex-col gap-xs lg:max-w-[369px] lg:gap-[14px]">
            <p className="heading-h4 font-medium">Poison the invoice. Watch the agent say PAY.</p>
            <p className="body-text-m">The agent can be fooled. The kernel and the vault cannot be sweet-talked. Every release leaves a receipt you can check without trusting us.</p>
          </div>
          <div className="hero__info-buttons lg:order order-last flex gap-xs md:justify-center lg:absolute lg:bottom-[22px] lg:left-1/2 lg:-translate-x-1/2 lg:justify-start">
            <div className="w-full md:w-auto">
              <span className="button-primary-s__wrapper w-full min-w-[162px] md:w-auto">
                <Link className="button-primary-s" href="#attack-sequence">
                  <span className="block">See the attack sequence -&gt; </span>
                </Link>
              </span>
            </div>
          </div>
          <AnimatePresence mode="wait">
            <motion.div
              key={active}
              initial={{ opacity: 0, y: 0 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 0 }}
              transition={{ duration: 0.4 }}
              id="attack-sequence"
              className="hero__info-right scroll-mt-[80px] flex w-full flex-col gap-xs lg:max-w-[338px] lg:gap-[14px]"
            >
              <p className="heading-h4 font-medium">{slide.title}</p>
              <div className="hero__info-left-inner flex flex-col items-start gap-sm md:items-center lg:items-start">
                {slide.text && <p className="body-text-m">{slide.text}</p>}
                {slide.button.text && (
                  <Link href={slide.button.link} className="body-text-s transition-all hover:text-gray-1000">
                    {slide.button.text}
                  </Link>
                )}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="hero__pagination mt-md">
          <div className="hero__pagination-wrapper flex items-center justify-center gap-0">
            {pagination.map((item, i) => (
              <button
                key={item.alt}
                type="button"
                className={`hero__pagination-item flex h-[40px] w-[40px] cursor-pointer select-none items-center justify-center transition-all hover:opacity-60 ${
                  active === i ? 'opacity-100' : 'opacity-20'
                }`}
                onClick={() => {
                  setActive(i);
                  setHideSquares(false);
                  setTimeout(() => setHideSquares(true), 500);
                }}
                tabIndex={0}
              >
                <Img
                  src={item.icon}
                  alt={`${item.alt} (Slide ${i + 1})`}
                  width={14}
                  height={15}
                  className="h-[14px] w-[14px]"
                  wrapperClass="!h-auto"
                />
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
