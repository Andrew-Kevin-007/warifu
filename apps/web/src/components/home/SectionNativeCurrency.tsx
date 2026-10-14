export default function SectionNativeCurrency() {
  return (
    <section className="section-native-currency my-80px lg:mb-xxl lg:mt-[104px] overflow-hidden">
      <div className="container">
        <div className="section-native-currency__heading mx-auto mb-lg flex max-w-[610px] flex-col items-center gap-sm text-center lg:mb-[60px]">
          <h4 className="heading-h1 gradient-text-black">
            Put the loss bound on the page.
          </h4>
        </div>
        <div className="section-native-currency__wrapper mx-auto flex max-w-[1024px] flex-col-reverse gap-sm lg:flex-row lg:items-center lg:justify-between lg:gap-lg">
          <p className="body-text-m section-native-currency__text lg:ml-80px lg:max-w-[340px]">
            The Loss Bound Certificate recalculates maximum exposure from current on-chain state and empirical results. It keeps assumptions and exclusions beside the bound, and becomes stale when its inputs change.
          </p>
          <div className="section-native-currency__image select-none lg:basis-[512px]">
            <span className="block h-full">
              <img alt="Illustration of a futuristic token kiosk" width={1536} height={1536} className="" src="/media/native-currency-image.7153755a.png" />
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
