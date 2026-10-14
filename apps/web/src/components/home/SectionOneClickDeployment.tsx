export default function SectionOneClickDeployment() {
  return (
    <section className="section-one-click-deployment my-80px lg:my-[56px] overflow-hidden">
      <div className="container">
        <div className="section-one-click-deployment__heading mx-auto mb-xxl flex max-w-[610px] flex-col items-center gap-sm text-center lg:mb-[80px]">
          <h4 className="heading-h1 gradient-text-black">
            From invoice to receipt, one bounded flow.
          </h4>
        </div>
        <div className="icon-title-text-card mx-auto max-w-[1024px]">
          <div className="icon-title-text-card__wrapper grid grid-cols-1 gap-xxl lg:grid-cols-3 lg:gap-xs">
            <div className="icon-title-text-card__item flex flex-col gap-sm lg:gap-md lg:px-lg lg:pb-lg lg:pt-96px">
              <div className="icon-title-text-card__image">
                <span className="block h-full">
                <img alt="" width={32} height={32} className="h-lg w-lg select-none" src="/media/deploy-2.1c40d347.svg" />
                </span>
              </div>
              <div className="icon-title-text-card__info flex flex-col gap-sm">
                <p className="font-primary text-22 font-medium leading-120 tracking-tight">
                  The agent proposes
                </p>
                <p className="body-text-s">
                  Invoice text becomes a suggested payee, amount and evidence set. The proposal cannot authorize its own payment.
                </p>
              </div>
            </div>
            <div className="icon-title-text-card__item flex flex-col gap-sm lg:gap-md lg:px-lg lg:pb-lg lg:pt-96px">
              <div className="icon-title-text-card__image">
                <span className="block h-full">
                <img alt="" width={32} height={32} className="h-lg w-lg select-none" src="/media/fair-launch.016d6b4f.svg" />
                </span>
              </div>
              <div className="icon-title-text-card__info flex flex-col gap-sm">
                <p className="font-primary text-22 font-medium leading-120 tracking-tight">
                  The kernel checks
                </p>
                <p className="body-text-s">
                  Deterministic rules check evidence, signed payment terms, policy, balances and history before returning a verdict.
                </p>
              </div>
            </div>
            <div className="icon-title-text-card__item flex flex-col gap-sm lg:gap-md lg:px-lg lg:pb-lg lg:pt-96px">
              <div className="icon-title-text-card__image">
                <span className="block h-full">
                <img alt="" width={32} height={32} className="h-lg w-lg select-none" src="/media/deploy.20bc9788.svg" />
                </span>
              </div>
              <div className="icon-title-text-card__info flex flex-col gap-sm">
                <p className="font-primary text-22 font-medium leading-120 tracking-tight">
                  The vault releases
                </p>
                <p className="body-text-s">
                  A valid attestation gates the release. The on-chain event anchors a receipt that can be checked later.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
