import { BRAND } from '@/lib/brand';
import Link from 'next/link';

export default function SectionAgentFrameworks() {
  return (
    <section className="section-agent-frameworks my-80px lg:my-xxl overflow-hidden">
      <div className="container">
        <div className="section-agent-frameworks__heading mx-auto mb-md flex max-w-[610px] flex-col items-center gap-sm text-center lg:mb-[57px]">
          <h4 className="heading-h1 gradient-text-black leading-130">
            One payment gate for every agent stack.
          </h4>
          <p className="subtitle-s section-agent-frameworks__text mx-auto max-w-[510px]">
            The framework marks are ecosystem examples, not integration claims. Every payment intent is untrusted; {BRAND.name} checks evidence, signed terms, policy, balances and history before a vault release.
          </p>
        </div>
        <div className="section-agent-frameworks__wrapper mx-auto flex max-w-[1024px] flex-col gap-sm lg:flex-row lg:items-center lg:gap-[106px]">
          <div className="section-agent-frameworks__image select-none lg:basis-[510px]">
            <span className="block h-full">
              <img alt="Illustration" width={1530} height={1917} className="" src="/media/agent-frameworks-image.ce699e32.png" />
            </span>
          </div>
          <div className="frameworks w-full lg:basis-[320px]">
            <div className="frameworks__wrapper flex flex-col">
              <Link className="frameworks__item group border-b-[0.5px] border-dashed border-[#CCCCCC] py-[20px] last:border-b-0 pointer-events-none" href="/docs">
                <div className="frameworks__item-heading flex items-center justify-between gap-sm">
                  <div className="flex flex-1 items-center gap-xs transition-all duration-300 lg:group-hover:translate-x-xs">
                    <span className="block h-full">
                      <img alt="Sona" width={24} height={24} className="h-md w-md select-none" src="/media/sona.ddf7a2ee.svg" />
                    </span>
                    <p className="flex-1 font-primary text-20 font-medium leading-100 tracking-tight">
                      Sona
                    </p>
                  </div>
                </div>
                <p className="body-text-s frameworks__item-description mt-[10px] text-gray-1000 transition-all duration-300 lg:max-w-[267px] lg:group-hover:translate-x-xs">
                  Invoice extraction may suggest a payee; it cannot release funds.
                </p>
              </Link>
              <Link className="frameworks__item group border-b-[0.5px] border-dashed border-[#CCCCCC] py-[20px] last:border-b-0 pointer-events-none" href="/docs">
                <div className="frameworks__item-heading flex items-center justify-between gap-sm">
                  <div className="flex flex-1 items-center gap-xs transition-all duration-300 lg:group-hover:translate-x-xs">
                    <span className="block h-full">
                      <img alt="Akira" width={24} height={24} className="h-md w-md select-none" src="/media/akira.978546c1.svg" />
                    </span>
                    <p className="flex-1 font-primary text-20 font-medium leading-100 tracking-tight">
                      Akira
                    </p>
                  </div>
                </div>
                <p className="body-text-s frameworks__item-description mt-[10px] text-gray-1000 transition-all duration-300 lg:max-w-[267px] lg:group-hover:translate-x-xs">
                  Signed terms bind the payee, budget cap and milestones.
                </p>
              </Link>
              <Link className="frameworks__item group border-b-[0.5px] border-dashed border-[#CCCCCC] py-[20px] last:border-b-0 pointer-events-none" href="/docs">
                <div className="frameworks__item-heading flex items-center justify-between gap-sm">
                  <div className="flex flex-1 items-center gap-xs transition-all duration-300 lg:group-hover:translate-x-xs">
                    <span className="block h-full">
                      <img alt="Solana Agent Kit" width={24} height={24} className="h-md w-md select-none" src="/media/solana.9e8c7239.svg" />
                    </span>
                    <p className="flex-1 font-primary text-20 font-medium leading-100 tracking-tight">
                      Solana Agent Kit
                    </p>
                  </div>
                </div>
                <p className="body-text-s frameworks__item-description mt-[10px] text-gray-1000 transition-all duration-300 lg:max-w-[267px] lg:group-hover:translate-x-xs">
                  The kernel checks evidence, policy, balances and history.
                </p>
              </Link>
              <Link className="frameworks__item group border-b-[0.5px] border-dashed border-[#CCCCCC] py-[20px] last:border-b-0 pointer-events-none" href="/docs">
                <div className="frameworks__item-heading flex items-center justify-between gap-sm">
                  <div className="flex flex-1 items-center gap-xs transition-all duration-300 lg:group-hover:translate-x-xs">
                    <span className="block h-full">
                      <img alt="Eliza" width={24} height={24} className="h-md w-md select-none" src="/media/eliza.81335d40.svg" />
                    </span>
                    <p className="flex-1 font-primary text-20 font-medium leading-100 tracking-tight">
                      Eliza
                    </p>
                  </div>
                </div>
                <p className="body-text-s frameworks__item-description mt-[10px] text-gray-1000 transition-all duration-300 lg:max-w-[267px] lg:group-hover:translate-x-xs">
                  Fresh state is checked again at release time.
                </p>
              </Link>
              <Link className="frameworks__item group border-b-[0.5px] border-dashed border-[#CCCCCC] py-[20px] last:border-b-0 pointer-events-none" href="/docs">
                <div className="frameworks__item-heading flex items-center justify-between gap-sm">
                  <div className="flex flex-1 items-center gap-xs transition-all duration-300 lg:group-hover:translate-x-xs">
                    <span className="block h-full">
                      <img alt="Rig" width={96} height={96} className="h-md w-md select-none" src="/media/rig.24847b6f.png" />
                    </span>
                    <p className="flex-1 font-primary text-20 font-medium leading-100 tracking-tight">
                      Rig
                    </p>
                  </div>
                </div>
                <p className="body-text-s frameworks__item-description mt-[10px] text-gray-1000 transition-all duration-300 lg:max-w-[267px] lg:group-hover:translate-x-xs">
                  The vault applies the cap and prevents a second release.
                </p>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
