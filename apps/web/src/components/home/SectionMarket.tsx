import { BRAND } from '@/lib/brand';
import Link from 'next/link';

export default function SectionMarket() {
  return (
    <section className="section-market relative my-80px lg:mb-xxl lg:mt-[140px] overflow-hidden">
      <div className="container">
        <div className="section-market__wrapper mx-auto flex max-w-[848px] flex-col gap-64px lg:flex-row lg:items-center lg:justify-between lg:gap-lg">
          <div className="section-market__info flex max-w-[440px] flex-col gap-md lg:gap-lg">
            <div className="section-market__heading flex flex-col gap-[12px]">
              <h3 className="heading-h2 gradient-text-black">
                One altered address can redirect a payment.
              </h3>
              <p className="body-text-l section-market__text max-w-[392px] text-gray-1000">
                An invoice can look routine while naming a different payout wallet. {BRAND.name} checks the payee against signed terms and evidence before the vault can release USDC.
              </p>
            </div>
            <div className="min-w-[156px]">
              <span className="button-primary-s__wrapper section-market__button min-w-[156px]">
                <Link className="button-primary-s" href="/#attack-sequence">
                  <span className="block">
                    Follow the attack sequence -&gt;
                  </span>
                </Link>
              </span>
            </div>
          </div>
          <div className="section-market__image lg:max-w-[254px] lg:translate-x-lg">
            <span className="block h-full">
              <img alt="Abstract purple burst sculpture" width={762} height={693} className="" src="/media/market-image.8bac8775.png" />
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
