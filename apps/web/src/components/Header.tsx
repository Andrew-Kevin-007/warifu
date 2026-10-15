'use client';

import { BRAND } from '@/lib/brand';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Every href here is a real route (no template leftovers). Challenge-profile builds hide the owner entry point.
const IS_CHALLENGE = process.env.NEXT_PUBLIC_PROFILE === 'challenge';

const NAV = [
  { href: '/judge', label: 'Judge path' },
  { href: '/attack-lab', label: 'Attack lab' },
  { href: '/blast-radius', label: 'Blast radius' },
  { href: '/certificate', label: 'Certificate' },
  { href: '/docs', label: 'Docs' },
  { href: '/about', label: 'About' },
];

const MORE = [
  { href: '/security', label: 'Security', icon: '/media/manifesto.7f727b3c.svg' },
  { href: '/pilot', label: 'Pilot', icon: '/media/consumer.1e94f547.svg' },
  { href: '/audit', label: 'Verify a receipt', icon: '/media/ecosystem.e2f98be3.svg' },
  { href: '/docs', label: 'Docs', icon: '/media/docs.2bea6a3a.svg' },
];

export default function Header() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 5);
    onScroll();
    document.addEventListener('scroll', onScroll, { passive: true });
    return () => document.removeEventListener('scroll', onScroll);
  }, []);

  // close the mobile menu on navigation
  useEffect(() => {
    setMenuOpen(false);
    setSubOpen(false);
    document.documentElement.style.overflow = '';
  }, [pathname]);

  const toggleMenu = () => {
    document.documentElement.style.overflow = menuOpen ? '' : 'hidden';
    setMenuOpen(!menuOpen);
  };
  const active = (href: string) => (pathname === href ? ' active' : '');
  const cta = IS_CHALLENGE ? { href: '/judge', label: 'Review the evidence' } : { href: '/dashboard', label: 'Connect Wallet' };

  return (
    <header className={`header fixed inset-x-0 top-0 z-50 flex items-center bg-white py-[12px] transition-all duration-500 before:absolute before:bottom-0 before:left-1/2 before:h-[0.5px] before:w-[calc(100%-32px)] before:-translate-x-1/2 before:bg-[#CCCCCC] lg:py-sm${scrolled ? ' header__fixed' : ''}`}>
      <div className="container-wide">
        <div className="header__navbar flex w-full items-center justify-between">
          <div className="header__logo z-110 inline-flex items-center">
            <Link className="header__logo-link relative inline-flex select-none items-center font-sans text-[20px] font-semibold tracking-[0.02em]" href="/">
              {BRAND.name.toUpperCase()}
              <span lang="ja" className="wf-kanji wf-kanji--header">
                {BRAND.kanji}
              </span>
            </Link>
          </div>
          <nav className="header__menu z-[12] hidden w-full lg:absolute lg:left-1/2 lg:right-auto lg:block lg:w-auto lg:-translate-x-1/2">
            <div className="relative flex w-full items-center justify-between gap-[4px] lg:w-auto lg:justify-start">
              <div className="header__menu-list relative z-1 flex w-full justify-start gap-[2px] rounded-[9px] bg-gray-400 p-[4px] transition-all duration-300">
                {NAV.map((n) => (
                  <div key={n.href} className="header__menu-list-item h-[34px] cursor-pointer">
                    <Link className={`tab-wrapper-m group is-reversed header__menu-list-link whitespace-nowrap${active(n.href)}`} href={n.href}>
                      <span className="tab-m">{n.label}</span>
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          </nav>
          <div className="header__burger-bg z-100 ml-auto flex h-[30px] w-[30px] items-center justify-center rounded-full border-[0.5px] border-black bg-black transition-all duration-300 lg:hidden">
            <button type="button" aria-label="Menu" onClick={toggleMenu} className={`header__burger relative z-100 block h-[18px] w-[24px] cursor-pointer transition-all before:absolute before:left-1/2 before:top-[2px] before:h-[1.5px] before:w-[11px] before:-translate-x-1/2 before:rounded-24 before:bg-white before:duration-300 after:absolute after:bottom-[2px] after:left-1/2 after:h-[1.5px] after:w-[11px] after:-translate-x-1/2 after:rounded-24 after:bg-white after:duration-300 lg:hidden${menuOpen ? ' active-burger' : ''}`}>
              <span className="absolute left-1/2 top-1/2 h-[1.5px] w-[17px] -translate-x-1/2 -translate-y-1/2 scale-100 rounded-24 bg-white transition-all duration-300" />
            </button>
          </div>
          <div className="header__buttons ml-auto hidden items-center gap-xs lg:flex">
            <div>
              <span className="button-primary-xs__wrapper">
                <Link className="button-primary-xs" href={cta.href}>
                  <span className="block">{cta.label}</span>
                  <span className="button-icon h-[18px] w-[18px]">
                    <img src="/media/connect.b96da826.svg" alt="" />
                  </span>
                </Link>
              </span>
            </div>
          </div>
          <div className={`mobile-menu fixed bottom-0 left-0 right-0 top-0 flex h-full w-full select-none flex-col items-center justify-start overflow-y-auto overflow-x-hidden overscroll-y-contain bg-white transition-all duration-300 xl:hidden ${menuOpen ? 'visible opacity-100' : 'pointer-events-none invisible opacity-0'}`}>
            <div className="pointer-events-none fixed left-0 top-0 z-100 h-[66px] w-full bg-white" />
            <div className="pointer-events-none fixed left-1/2 top-[66px] h-[0.5px] w-[calc(100%-32px)] -translate-x-1/2 bg-[#CCCCCC]" />
            <div className="container">
              <div className="mobile-menu__wrapper mt-80px flex h-full w-full flex-col items-center justify-between pt-[30px]">
                <div className="mobile-menu__inner flex w-full flex-col gap-md">
                  {NAV.map((n) => (
                    <Link key={n.href} className="header__menu-list-link heading-h6 w-full px-xs" href={n.href}>
                      {n.label}
                    </Link>
                  ))}
                  <div className="header__menu-list-item relative w-full rounded-12 transition-all">
                    <button type="button" onClick={() => setSubOpen(!subOpen)} className={`header__submenu-title heading-h6 relative block w-full cursor-pointer whitespace-nowrap px-xs text-left transition-colors${subOpen ? ' active mb-sm' : ''}`}>
                      More
                    </button>
                    <div className={`header__submenu-wrapper w-full transition-all ${subOpen ? 'active pointer-events-auto !visible max-h-[600px] !opacity-100' : 'pointer-events-none invisible max-h-0 opacity-0'}`}>
                      <div className="header__submenu w-full overflow-hidden">
                        <span className="header__submenu-items flex flex-col rounded-12 border-[0.5px] border-gray-700">
                          {MORE.map((m) => (
                            <div key={m.href + m.label} className="header__submenu-item relative w-full">
                              <Link className="header__submenu-link flex w-full items-start gap-[12px] px-sm py-[14px] transition-all" href={m.href}>
                                <span className="header__submenu-link-icon mt-[3px] flex items-center justify-center">
                                  <span className="block h-[18px] w-[18px] bg-black bg-contain transition-all" style={{ mask: `url(${m.icon}) no-repeat 50% 50%`, WebkitMask: `url(${m.icon}) no-repeat 50% 50%`, WebkitMaskSize: 'cover', maskSize: 'cover' }} />
                                </span>
                                <span className="header__submenu-link-info flex-1">
                                  <p className="header__submenu-link-title body-text-m w-max transition-all">
                                    <span>{m.label}</span>
                                  </p>
                                </span>
                              </Link>
                            </div>
                          ))}
                        </span>
                      </div>
                    </div>
                  </div>
                  <Link className="header__menu-list-link heading-h6 w-full px-xs" href={cta.href}>
                    {cta.label}
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
