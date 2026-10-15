import { BRAND } from '@/lib/brand';
import Link from 'next/link';
import Reveal from '@/components/ui/Reveal';

export default function SectionGateway() {
  return (
    <section className="section-gateway relative mb-80px pt-80px lg:mb-[140px] lg:pt-[56px] overflow-hidden">
      <div className="container">
        <div className="section-top-shadow" />
        <div className="section-gateway__heading relative z-2 mx-auto mb-[56px] flex max-w-[630px] flex-col items-center gap-[14px] text-center">
          <h3 className="heading-h1 gradient-text-black">
            A logo isn’t a security check.
          </h3>
        </div>
        <div className="section-gateway__wrapper relative z-2 mx-auto grid max-w-[848px] grid-cols-1 gap-xs lg:grid-cols-2">
          <Reveal className="card-black group h-full rounded-[16px] p-[0.5px]">
            <a className="card-stack__item translate-z-0 relative flex h-full flex-col overflow-hidden rounded-16">
              <div className="card-stack__inner relative overflow-hidden rounded-16 px-md pt-md">
                <div className="card-stack__info relative z-[6] flex flex-col gap-[10px] lg:max-w-[312px]">
                  <h3 className="heading-h6 card-stack__title">
                    The payment still needs a verdict.
                  </h3>
                  <p className="body-text-m card-stack__text text-gray-1000 lg:max-w-[304px]">
                    On Arc, {BRAND.name} checks invoice evidence, signed terms, policy, and payment history before the vault releases USDC.
                  </p>
                </div>
              </div>
              <div className="card-stack__figure pointer-events-none w-full select-none">
                <div className="figure mx-auto w-full max-w-[400px] transition-all duration-500 ease-[cubic-bezier(0,0.35,0.15,1)] lg:group-hover:scale-110 lg:group-hover:duration-[1400ms]">
                  <span className="block h-full">
                      <img alt="" width={1206} height={1209} className="" src="/media/stack-figure-5.c18ecf62.png" />
                  </span>
                </div>
              </div>
            </a>
          </Reveal>
          <div className="flex flex-col gap-xs">
            <Reveal className="group h-full rounded-[16px] p-[0.5px] card-light">
              <Link className="card-stack__item translate-z-0 relative block h-full overflow-hidden rounded-16" href="/judge">
                <div className="card-stack__figure pointer-events-none select-none">
                  <div className="figure absolute right-[-15%] top-[-25%] w-[390px] transition-all duration-500 ease-[cubic-bezier(0,0.35,0.15,1)] lg:group-hover:scale-110 lg:group-hover:duration-[1400ms]">
                    <span className="block h-full">
                      <img alt="" width={787} height={787} className="" src="/media/stack-figure-3.9155d048.png" />
                    </span>
                  </div>
                </div>
                <div className="card-stack__inner relative h-full overflow-hidden rounded-16 px-md pb-md pt-[270px] lg:pt-[180px] lg:h-[316px]">
                  <div className="card-stack__info relative z-[6] flex h-full flex-col justify-end gap-[10px] lg:max-w-[312px]">
                    <h3 className="heading-h6 card-stack__title">
                      A confident proposal can still be wrong.
                    </h3>
                    <p className="body-text-m card-stack__text text-gray-1000 lg:max-w-[240px]">
                      Invoice extraction suggests a payout address; that suggestion cannot move funds.
                    </p>
                  </div>
                </div>
              </Link>
            </Reveal>
            <Reveal className="group h-full rounded-[16px] p-[0.5px] card-light">
              <Link className="card-stack__item translate-z-0 relative block h-full overflow-hidden rounded-16" href="/attack-lab">
                <div className="card-stack__figure pointer-events-none select-none">
                  <div className="figure absolute right-[-17%] top-[-38%] w-[400px] transition-all duration-500 ease-[cubic-bezier(0,0.35,0.15,1)] lg:group-hover:scale-110 lg:group-hover:duration-[1400ms]">
                    <span className="block h-full">
                      <img alt="" width={1030} height={1030} className="" src="/media/stack-figure-2.03d9bb70.png" />
                    </span>
                  </div>
                </div>
                <div className="card-stack__inner relative h-full overflow-hidden rounded-16 px-md pb-md pt-[270px] lg:pt-[180px] lg:h-[316px]">
                  <div className="card-stack__info relative z-[6] flex h-full flex-col justify-end gap-[10px] lg:max-w-[312px]">
                    <h3 className="heading-h6 card-stack__title">
                      Several signals. One bounded release.
                    </h3>
                    <p className="body-text-m card-stack__text text-gray-1000 lg:max-w-[240px]">
                      Evidence, terms, policy, and payment history shape the verdict. The vault applies the cap and records a receipt.
                    </p>
                  </div>
                </div>
              </Link>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
