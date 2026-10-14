export default function SectionPartners() {
  return (
    <section className="section-partners relative py-80px lg:pb-80px lg:pt-120px overflow-hidden" id="partners">
      <div className="container">
        <div className="section-top-shadow" />
        <div className="section-partners__wrapper relative z-2 mx-auto flex max-w-[740px] flex-col gap-xxl lg:flex-row lg:justify-between">
          <div className="section-partners__incubated">
            <div className="section-partners__exchange flex flex-col items-center gap-xl lg:gap-xxl">
              <p className="heading-h6">
                Supported By
              </p>
              <div className="logos-exchange grid gap-xl lg:flex grid-cols-1">
                <div className="logos-exchange__item flex flex-col items-center gap-sm lg:gap-md">
                  <div className="logos-exchange__image flex h-xl items-center justify-center">
                    <span className="block h-full">
                      <img alt="Solana Foundation" width={52} height={40} className="mx-auto max-w-[80%] select-none lg:max-w-full" src="/media/solana-symbol.d4bfd27f.svg" />
                    </span>
                  </div>
                  <p className="body-text-m logos-exchange__text">
                    Solana Foundation
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div className="section-partners__divider h-[1px] w-full bg-black bg-opacity-20 lg:h-[175px] lg:w-[1px]" />
          <div className="section-partners__exchange">
            <div className="section-partners__exchange flex flex-col items-center gap-xl lg:gap-xxl">
              <p className="heading-h6">
                Exchange Partners
              </p>
              <div className="logos-exchange grid gap-xl lg:flex grid-cols-2">
                <div className="logos-exchange__item flex flex-col items-center gap-sm lg:gap-md">
                  <div className="logos-exchange__image flex h-xl items-center justify-center">
                    <span className="block h-full">
                      <img alt="Bybit" width={100} height={39} className="mx-auto max-w-[80%] select-none lg:max-w-full" src="/media/bybit-symbol.86469c2a.svg" />
                    </span>
                  </div>
                  <p className="body-text-m logos-exchange__text">
                    Bybit
                  </p>
                </div>
                <div className="logos-exchange__item flex flex-col items-center gap-sm lg:gap-md">
                  <div className="logos-exchange__image flex h-xl items-center justify-center">
                    <span className="block h-full">
                      <img alt="GATE.IO" width={39} height={39} className="mx-auto max-w-[80%] select-none lg:max-w-full" src="/media/gate-symbol.d7ebb727.svg" />
                    </span>
                  </div>
                  <p className="body-text-m logos-exchange__text">
                    GATE.IO
                  </p>
                </div>
                <div className="logos-exchange__item flex flex-col items-center gap-sm lg:gap-md">
                  <div className="logos-exchange__image flex h-xl items-center justify-center">
                    <span className="block h-full">
                      <img alt="MexC" width={52} height={32} className="mx-auto max-w-[80%] select-none lg:max-w-full" src="/media/mexc-symbol.b20064eb.svg" />
                    </span>
                  </div>
                  <p className="body-text-m logos-exchange__text">
                    MexC
                  </p>
                </div>
                <div className="logos-exchange__item flex flex-col items-center gap-sm lg:gap-md">
                  <div className="logos-exchange__image flex h-xl items-center justify-center">
                    <span className="block h-full">
                      <img alt="Bitpanda" width={27} height={40} className="mx-auto max-w-[80%] select-none lg:max-w-full" src="/media/bitpanda-symbol.c3eec6b6.svg" />
                    </span>
                  </div>
                  <p className="body-text-m logos-exchange__text">
                    Bitpanda
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
