export default function SectionPartnersLine() {
  return (
    <section className="section-partners-line my-80px lg:mb-[104px] lg:mt-96px overflow-hidden">
      <div className="container">
        <div className="logos-line flex w-full flex-col items-center gap-sm overflow-hidden">
          <p className="body-text-m logos-line__title text-center text-gray-900">
            Across the ecosystem, payment authority stays bounded.
          </p>
          <div className="logos-line__wrapper grid w-full grid-cols-2 items-center justify-center gap-xs sm:grid-cols-3 lg:flex lg:flex-row lg:gap-md">
            <div className="logos-line__item flex justify-center">
              <span className="block h-full">
                <img alt="Gate.io" width={140} height={57} className="select-none w-[140px]" src="/media/gate.1f67d450.svg" />
              </span>
            </div>
            <div className="logos-line__item flex justify-center">
              <span className="block h-full">
                <img alt="Bybit" width={140} height={57} className="select-none w-[140px]" src="/media/bybit.259e7892.svg" />
              </span>
            </div>
            <div className="logos-line__item flex justify-center">
              <span className="block h-full">
                <img alt="Solana Foundation" width={140} height={57} className="select-none w-[140px]" src="/media/solana-foundation.38713d71.svg" />
              </span>
            </div>
            <div className="logos-line__item flex justify-center">
              <span className="block h-full">
                <img alt="Nvidia" width={140} height={57} className="select-none w-[140px]" src="/media/nvidia-new.0752853c.svg" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
