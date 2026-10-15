'use client';

import { BRAND } from '@/lib/brand';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { motion } from 'framer-motion';

const FooterFigures = dynamic(() => import('@/components/FooterFigures'), { ssr: false });

export default function Footer() {
  const ctaRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  // the CTA draws itself in once, when half of it is on screen
  useEffect(() => {
    const el = ctaRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <footer className="footer relative overflow-hidden">
      <div ref={ctaRef} className="footer__cta relative pb-80px pt-80px lg:pb-[96px] lg:pt-[140px]">
        <div className="footer__cta-grid absolute left-1/2 top-0 mx-auto w-[900px] -translate-x-1/2 lg:w-[1244px]">
          <motion.div className="footer__cta-bg w-full" initial={{ opacity: 0 }} animate={{ opacity: inView ? 1 : 0 }} transition={{ duration: 0.7, ease: "easeInOut", delay: 1 }}>
            <span className="block h-full">
              <img alt="Background" width={1246} height={487} className="w-full" src="/media/footer-cta-bg.bef33713.png" />
            </span>
          </motion.div>
          <div className="footer__cta-grid absolute top-0 z-2">
            <svg width={1248} height={563} viewBox="0 0 1248 563" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-auto w-full max-w-full">
              <motion.path d="M566.507 486.369C604.77 485.552 643.058 485.548 681.32 486.358" stroke="url(#paint1_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0.5 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0.5 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 1.0 }} />
              <motion.path d="M452.074 411.252C566.457 406.945 681.54 406.939 795.925 411.232" stroke="url(#paint2_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0.5 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0.5 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.8 }} />
              <motion.path d="M910.542 333.608C720.596 329.913 527.405 329.911 337.456 333.603" stroke="url(#paint3_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0.5 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0.5 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.6 }} />
              <motion.path d="M224.476 246.882C488.079 255.081 760.556 255.078 1024.15 246.873" stroke="url(#paint4_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0.5 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0.5 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.4 }} />
              <motion.path d="M112.071 145.979C447.281 185.546 801.357 185.535 1136.56 145.947" stroke="url(#paint5_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0.5 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0.5 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.2 }} />
              <motion.path d="M1 23.957C404.854 123.169 843.146 123.169 1247 23.957" stroke="url(#paint6_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0.5 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0.5 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.0 }} />
              <motion.path d="M1136.08 -1L1136.08 246.721" stroke="url(#paint7_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.0 }} />
              <motion.path d="M1023.31 -1L1023.31 333.608" stroke="url(#paint8_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.2 }} />
              <motion.path d="M910.544 -1C910.544 136.112 910.544 273.224 910.544 410.328" stroke="url(#paint9_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.4 }} />
              <motion.path d="M795.926 -1C795.926 161.066 795.926 323.133 795.926 485.199" stroke="url(#paint10_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.6 }} />
              <motion.path d="M681.309 -1L681.309 562.843" stroke="url(#paint11_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.8 }} />
              <motion.path d="M566.691 -1L566.691 562.843" stroke="url(#paint12_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.8 }} />
              <motion.path d="M452.074 -1L452.074 485.199" stroke="url(#paint13_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.6 }} />
              <motion.path d="M337.456 -1C337.456 136.112 337.456 273.224 337.456 410.328" stroke="url(#paint14_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.4 }} />
              <motion.path d="M224.689 -1L224.689 333.608" stroke="url(#paint15_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.2 }} />
              <motion.path d="M111.92 -1L111.92 246.721" stroke="url(#paint16_linear_10315_4205)" strokeWidth="0.5" strokeMiterlimit="10" initial={{ pathLength: 0, pathOffset: 0 }} animate={inView ? { pathLength: 1, pathOffset: 0 } : { pathLength: 0, pathOffset: 0 }} transition={{ duration: 0.5, ease: "easeInOut", delay: 0.0 }} />
              <defs>
                <linearGradient id="paint1_linear_10315_4205" x1="566.507" y1="486.061" x2="681.32" y2="486.061" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" stopOpacity="0" />
                  <stop offset="0.502408" stopColor="#9280FC" />
                  <stop offset="1" stopColor="#9280FC" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint2_linear_10315_4205" x1="452.074" y1="409.635" x2="795.925" y2="409.635" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" stopOpacity="0" />
                  <stop offset="0.502408" stopColor="#9280FC" />
                  <stop offset="1" stopColor="#9280FC" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint3_linear_10315_4205" x1="337.456" y1="332.222" x2="910.542" y2="332.222" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" stopOpacity="0" />
                  <stop offset="0.502408" stopColor="#9280FC" />
                  <stop offset="1" stopColor="#9280FC" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint4_linear_10315_4205" x1="224.476" y1="249.951" x2="1024.15" y2="249.951" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" stopOpacity="0" />
                  <stop offset="0.502408" stopColor="#9280FC" />
                  <stop offset="1" stopColor="#9280FC" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint5_linear_10315_4205" x1="112.071" y1="160.797" x2="1136.56" y2="160.797" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" stopOpacity="0" />
                  <stop offset="0.502408" stopColor="#9280FC" />
                  <stop offset="1" stopColor="#9280FC" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint6_linear_10315_4205" x1="1" y1="61.1614" x2="1247" y2="61.1614" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" stopOpacity="0" />
                  <stop offset="0.502408" stopColor="#9280FC" />
                  <stop offset="1" stopColor="#9280FC" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint7_linear_10315_4205" x1="1136.58" y1="-1" x2="1136.58" y2="246.721" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" />
                  <stop offset="0.62" stopColor="#C16AFF" />
                  <stop offset="1" stopColor="#C966FF" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint8_linear_10315_4205" x1="1023.81" y1="-1" x2="1023.81" y2="333.608" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" />
                  <stop offset="0.62" stopColor="#C16AFF" />
                  <stop offset="1" stopColor="#C966FF" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint9_linear_10315_4205" x1="911.044" y1="-1" x2="911.044" y2="410.328" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" />
                  <stop offset="0.62" stopColor="#C16AFF" />
                  <stop offset="1" stopColor="#C966FF" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint10_linear_10315_4205" x1="796.426" y1="-1" x2="796.426" y2="485.199" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" />
                  <stop offset="0.62" stopColor="#C16AFF" />
                  <stop offset="1" stopColor="#C966FF" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint11_linear_10315_4205" x1="681.809" y1="-1" x2="681.809" y2="562.843" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" />
                  <stop offset="0.62" stopColor="#C16AFF" />
                  <stop offset="1" stopColor="#C966FF" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint12_linear_10315_4205" x1="567.191" y1="-1" x2="567.191" y2="562.843" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" />
                  <stop offset="0.62" stopColor="#C16AFF" />
                  <stop offset="1" stopColor="#C966FF" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint13_linear_10315_4205" x1="452.574" y1="-1" x2="452.574" y2="485.199" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" />
                  <stop offset="0.62" stopColor="#C16AFF" />
                  <stop offset="1" stopColor="#C966FF" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint14_linear_10315_4205" x1="337.956" y1="-1" x2="337.956" y2="410.328" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" />
                  <stop offset="0.62" stopColor="#C16AFF" />
                  <stop offset="1" stopColor="#C966FF" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint15_linear_10315_4205" x1="225.189" y1="-1" x2="225.189" y2="333.608" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" />
                  <stop offset="0.62" stopColor="#C16AFF" />
                  <stop offset="1" stopColor="#C966FF" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="paint16_linear_10315_4205" x1="112.42" y1="-1" x2="112.42" y2="246.721" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#9280FC" />
                  <stop offset="0.62" stopColor="#C16AFF" />
                  <stop offset="1" stopColor="#C966FF" stopOpacity="0" />
                </linearGradient>
              </defs>
            </svg>
          </div>
        </div>
        <div className="container">
          <motion.div className="footer__cta-wrapper relative z-5 mx-auto flex max-w-[672px] flex-col gap-xl text-center" initial={{ opacity: 0 }} animate={{ opacity: inView ? 1 : 0 }} transition={{ duration: 0.7, ease: "easeInOut", delay: 1 }}>
            <div className="footer__cta-heading flex flex-col gap-sm">
              <h5 className="heading-hero gradient-text-black">
                Poison the invoice. Inspect the verdict.
              </h5>
              <p className="subtitle-s">
                Follow a changed payout address through the agent proposal, kernel decision, vault limit and verifiable receipt.
              </p>
            </div>
            <div className="min-w-[162px]">
              <span className="button-primary-m__wrapper min-w-[162px]">
                <Link href="/#attack-sequence" className="button-primary-m">
                  <span className="block">
                    See the attack sequence -&gt;
                  </span>
                </Link>
              </span>
            </div>
          </motion.div>
        </div>
      </div>
      <div className="footer__wrapper relative mt-[100px] pb-64px pt-[260px] lg:pb-[100px] lg:pt-[260px]">
        <div className="footer__bg pointer-events-none absolute left-0 top-0 z-4 h-full w-full select-none">
          <svg width={1408} height={521} viewBox="0 0 1408 521" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" className="h-full w-full max-w-full">
            <path d="M1614 523V0H-206V523H1614Z" fill="url(#paint0_linear_10262_5040)" />
            <defs>
              <linearGradient id="paint0_linear_10262_5040" x1="711.005" y1="531.229" x2="714.769" y2="-0.25542" gradientUnits="userSpaceOnUse">
                <stop offset="0.161398" />
                <stop offset="0.917159" stopOpacity="0.7" />
                <stop offset="0.945219" stopOpacity="0" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div className="footer__wave--1 pointer-events-none absolute left-0 top-[8px] z-2 w-full select-none lg:top-[12px]">
          <svg width={1408} height={39} viewBox="0 0 1408 39" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" className="h-[80px] w-full max-w-full animate-[flying_8s_ease-in-out_1s_infinite] blur-[1px] lg:h-full">
            <path d="M1614 38.9999V0.183105C1614 0.183105 1329.09 8.45229 1209 11C941.165 16.6823 823 19 621 19C458 19 279.569 6 64 6C-43.3942 6 -206 0.183105 -206 0.183105V38.9999H1614Z" fill="url(#paint0_linear_10262_5042)" />
            <defs>
              <linearGradient id="paint0_linear_10262_5042" x1="711.005" y1="39.6107" x2="711.026" y2="0.162294" gradientUnits="userSpaceOnUse">
                <stop stopOpacity="0" />
                <stop offset="1" stopOpacity="0.34" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div className="footer__wave--2 pointer-events-none absolute left-0 top-[16px] z-3 w-full select-none lg:top-[19px]">
          <svg width={1408} height={28} viewBox="0 0 1408 28" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" className="h-[40px] w-full max-w-full animate-[flying_5s_ease-in-out_infinite] blur-[1px] lg:h-full">
            <path d="M1614 28V0.131536C1614 0.131536 1427.09 6.78412 1307 8.61324C1039.17 12.6929 889 1.60822 621 0.131536C405.451 -1.05614 282.569 6.1899 67 6.1899C-40.3942 6.1899 -206 0.131536 -206 0.131536V28H1614Z" fill="url(#paint0_linear_10262_5041)" />
            <defs>
              <linearGradient id="paint0_linear_10262_5041" x1="711.005" y1="28.4385" x2="711.016" y2="0.116512" gradientUnits="userSpaceOnUse">
                <stop stopOpacity="0" />
                <stop offset="1" stopOpacity="0.34" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div className="footer__figures absolute left-0 top-[-360px] z-1 h-[800px] w-full lg:top-[-360px] lg:h-[800px]">
          <FooterFigures />
        </div>
        <div className="container">
          <div className="footer__inner relative z-5 mx-auto flex max-w-[1024px] flex-col gap-xl pt-xs lg:flex-row lg:justify-between">
            <div className="footer__grid pointer-events-none absolute left-0 top-0 z-0 hidden h-full w-full select-none lg:block">
              <span className="block h-full">
                <img alt="Grid" width={1024} height={235} className="h-[235px]" src="/media/footer-grid.988a5fd6.svg" />
              </span>
            </div>
            <div className="footer__left flex flex-col gap-xxl lg:basis-[35%]">
              <div className="footer__docs hidden flex-col items-start gap-xs lg:flex">
                <Link className="footer__bottom-link text-gray-900 hover:text-cta" href="/security">
                  <p className="body-text-xs">
                    <span>
                      Security and disclosure↘
                    </span>
                  </p>
                </Link>
                <Link className="footer__bottom-link text-gray-900 hover:text-cta" href="/docs">
                  <p className="body-text-xs">
                    <span>
                      Docs↘
                    </span>
                  </p>
                </Link>
              </div>
              <p className="body-text-xxs hidden text-gray-900 lg:block">
                {`${BRAND.name} ${BRAND.kanji} © `}
                2026
                . All rights reserved.
              </p>
            </div>
            <div className="footer__menu relative z-4 grid grid-cols-2 gap-x-sm gap-y-xxl lg:basis-[58%] lg:grid-cols-3 lg:gap-x-[52px] xl:basis-[57%] xl:gap-x-[72px]">
              <div className="footer__menu-group flex flex-col gap-sm lg:gap-[59px]">
                <p className="body-text-m text-gray-900">
                  About
                </p>
                <div className="footer__menu-links flex flex-col items-start gap-xs">
                  <Link className="footer__menu-link group flex items-center gap-xs text-white hover:text-cta" href="/about">
                    <p className="body-text-s">
                      About {BRAND.name}
                    </p>
                  </Link>
                  <Link className="footer__menu-link group flex items-center gap-xs text-white hover:text-cta" href="/docs">
                    <p className="body-text-s">
                      Docs
                    </p>
                  </Link>
                  <Link className="footer__menu-link group flex items-center gap-xs text-white hover:text-cta" href="/security">
                    <p className="body-text-s">
                      Security
                    </p>
                  </Link>
                  <Link className="footer__menu-link group flex items-center gap-xs text-white hover:text-cta" href="/pilot">
                    <p className="body-text-s">
                      Pilot
                    </p>
                  </Link>
                </div>
              </div>
              <div className="footer__menu-group flex flex-col gap-sm lg:gap-[59px]">
                <p className="body-text-m text-gray-900">
                  Evidence
                </p>
                <div className="footer__menu-links flex flex-col items-start gap-xs">
                  <Link className="footer__menu-link group flex items-center gap-xs text-white hover:text-cta" href="/judge">
                    <p className="body-text-s">
                      Judge path
                    </p>
                  </Link>
                  <Link className="footer__menu-link group flex items-center gap-xs text-white hover:text-cta" href="/attack-lab">
                    <p className="body-text-s">
                      Attack lab
                    </p>
                  </Link>
                  <Link className="footer__menu-link group flex items-center gap-xs text-white hover:text-cta" href="/blast-radius">
                    <p className="body-text-s">
                      Blast radius
                    </p>
                  </Link>
                  <Link className="footer__menu-link group flex items-center gap-xs text-white hover:text-cta" href="/certificate">
                    <p className="body-text-s">
                      Loss bound certificate
                    </p>
                  </Link>
                </div>
              </div>
              <div className="footer__menu-group flex flex-col gap-sm lg:gap-[59px]">
                <p className="body-text-m text-gray-900">
                  Verify
                </p>
                <div className="footer__menu-links flex flex-col items-start gap-xs">
                  <Link className="footer__menu-link group flex items-center gap-xs text-white hover:text-cta" href="/audit">
                    <p className="body-text-s">
                      Verify a receipt
                    </p>
                  </Link>
                  <Link className="footer__menu-link group flex items-center gap-xs text-white hover:text-cta" href="/replay/main">
                    <p className="body-text-s">
                      Recorded run
                    </p>
                  </Link>
                </div>
              </div>
            </div>
          </div>
          <div className="footer__bottom--mobile relative z-5 mt-xxl flex flex-col gap-md lg:hidden">
            <div className="footer__docs flex gap-sm">
              <Link className="footer__bottom-link text-gray-900 hover:text-cta" href="/security">
                <p className="body-text-xs">
                  <span>
                    Security and disclosure↘
                  </span>
                </p>
              </Link>
              <Link className="footer__bottom-link text-gray-900 hover:text-cta" href="/docs">
                <p className="body-text-xs">
                  <span>
                    Docs↘
                  </span>
                </p>
              </Link>
            </div>
            <p className="body-text-xxs text-gray-900">
              {`${BRAND.name} ${BRAND.kanji} © `}
              2026
              . All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
