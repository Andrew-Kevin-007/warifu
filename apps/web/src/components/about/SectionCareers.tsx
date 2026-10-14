import Link from 'next/link';

export default function SectionCareers() {
  return (
    <section className="section-careers relative mb-80px pt-80px lg:mb-[120px] lg:pt-[120px] overflow-hidden" id="payment-path">
      <div className="container">
        <div className="section-top-shadow" />
        <div className="section-careers-hero__heading mx-auto mb-64px flex max-w-[497px] flex-col items-center gap-[12px] text-center lg:mb-96px">
          <p className="body-text-s">
            For the reviewer
          </p>
          <h3 className="heading-h3">
            What can you verify after a release?
          </h3>
        </div>
        <div className="section-careers__wrapper relative z-2 mx-auto max-w-[671px]">
          <div className="positions w-full">
            <div className="positions__wrapper flex flex-col gap-sm">
              <Link className="positions__item group border-b border-gray-500 pb-sm" href="/#attack-sequence">
                <div className="positions__item-heading flex items-center justify-between gap-sm">
                  <h5 className="heading-h5 flex-1 transition-all duration-300 lg:group-hover:translate-x-sm">
                    Requested payment
                  </h5>
                  <span className="block h-[18px] w-[18px] bg-black transition-all duration-300 lg:group-hover:translate-x-[3px] lg:group-hover:translate-y-[-3px]" style={{mask: "url(/media/arrow-right-top-fill.1598bdbe.svg) 50% 50% / cover no-repeat"}} />
                </div>
                <div className="positions__item-tags mt-[12px] flex flex-wrap gap-xs transition-all duration-300 lg:group-hover:translate-x-sm">
                  <div className="small-tag-wrapper">
                    <span className="small-tag">
                      <span className="small-tag-inner">
                        Payee + amount
                      </span>
                    </span>
                  </div>
                  <div className="small-tag-wrapper">
                    <span className="small-tag">
                      <span className="small-tag-inner">
                        Invoice reference
                      </span>
                    </span>
                  </div>
                </div>
                <div className="positions__item-info mt-sm flex flex-wrap items-center gap-sm transition-all duration-300 lg:group-hover:translate-x-sm">
                  <p className="body-text-s positions__item-location flex items-center gap-[6px]">
                    <span className="block h-full">
                      <img alt="" width={18} height={19} className="select-none" src="/media/location.07aa920e.svg" />
                    </span>
                    From: invoice intent
                  </p>
                  <p className="body-text-s positions__item-type flex items-center gap-[6px]">
                    <span className="block h-full">
                      <img alt="" width={18} height={19} className="select-none" src="/media/time.a37b57fa.svg" />
                    </span>
                    Stage: before decision
                  </p>
                </div>
              </Link>
              <Link className="positions__item group border-b border-gray-500 pb-sm" href="/#attack-sequence">
                <div className="positions__item-heading flex items-center justify-between gap-sm">
                  <h5 className="heading-h5 flex-1 transition-all duration-300 lg:group-hover:translate-x-sm">
                    Decision record
                  </h5>
                  <span className="block h-[18px] w-[18px] bg-black transition-all duration-300 lg:group-hover:translate-x-[3px] lg:group-hover:translate-y-[-3px]" style={{mask: "url(/media/arrow-right-top-fill.1598bdbe.svg) 50% 50% / cover no-repeat"}} />
                </div>
                <div className="positions__item-tags mt-[12px] flex flex-wrap gap-xs transition-all duration-300 lg:group-hover:translate-x-sm">
                  <div className="small-tag-wrapper">
                    <span className="small-tag">
                      <span className="small-tag-inner">
                        Verdict
                      </span>
                    </span>
                  </div>
                  <div className="small-tag-wrapper">
                    <span className="small-tag">
                      <span className="small-tag-inner">
                        Reason codes
                      </span>
                    </span>
                  </div>
                </div>
                <div className="positions__item-info mt-sm flex flex-wrap items-center gap-sm transition-all duration-300 lg:group-hover:translate-x-sm">
                  <p className="body-text-s positions__item-location flex items-center gap-[6px]">
                    <span className="block h-full">
                      <img alt="" width={18} height={19} className="select-none" src="/media/location.07aa920e.svg" />
                    </span>
                    From: signed receipt
                  </p>
                  <p className="body-text-s positions__item-type flex items-center gap-[6px]">
                    <span className="block h-full">
                      <img alt="" width={18} height={19} className="select-none" src="/media/time.a37b57fa.svg" />
                    </span>
                    Stage: at decision
                  </p>
                </div>
              </Link>
              <Link className="positions__item group border-b border-gray-500 pb-sm" href="/#attack-sequence">
                <div className="positions__item-heading flex items-center justify-between gap-sm">
                  <h5 className="heading-h5 flex-1 transition-all duration-300 lg:group-hover:translate-x-sm">
                    On-chain event
                  </h5>
                  <span className="block h-[18px] w-[18px] bg-black transition-all duration-300 lg:group-hover:translate-x-[3px] lg:group-hover:translate-y-[-3px]" style={{mask: "url(/media/arrow-right-top-fill.1598bdbe.svg) 50% 50% / cover no-repeat"}} />
                </div>
                <div className="positions__item-tags mt-[12px] flex flex-wrap gap-xs transition-all duration-300 lg:group-hover:translate-x-sm">
                  <div className="small-tag-wrapper">
                    <span className="small-tag">
                      <span className="small-tag-inner">
                        Intent ID
                      </span>
                    </span>
                  </div>
                  <div className="small-tag-wrapper">
                    <span className="small-tag">
                      <span className="small-tag-inner">
                        Receipt hash
                      </span>
                    </span>
                  </div>
                </div>
                <div className="positions__item-info mt-sm flex flex-wrap items-center gap-sm transition-all duration-300 lg:group-hover:translate-x-sm">
                  <p className="body-text-s positions__item-location flex items-center gap-[6px]">
                    <span className="block h-full">
                      <img alt="" width={18} height={19} className="select-none" src="/media/location.07aa920e.svg" />
                    </span>
                    From: Arc vault
                  </p>
                  <p className="body-text-s positions__item-type flex items-center gap-[6px]">
                    <span className="block h-full">
                      <img alt="" width={18} height={19} className="select-none" src="/media/time.a37b57fa.svg" />
                    </span>
                    Stage: on release
                  </p>
                </div>
              </Link>
              <Link className="positions__item group border-b border-gray-500 pb-sm" href="/#attack-sequence">
                <div className="positions__item-heading flex items-center justify-between gap-sm">
                  <h5 className="heading-h5 flex-1 transition-all duration-300 lg:group-hover:translate-x-sm">
                    Exposure bound
                  </h5>
                  <span className="block h-[18px] w-[18px] bg-black transition-all duration-300 lg:group-hover:translate-x-[3px] lg:group-hover:translate-y-[-3px]" style={{mask: "url(/media/arrow-right-top-fill.1598bdbe.svg) 50% 50% / cover no-repeat"}} />
                </div>
                <div className="positions__item-tags mt-[12px] flex flex-wrap gap-xs transition-all duration-300 lg:group-hover:translate-x-sm">
                  <div className="small-tag-wrapper">
                    <span className="small-tag">
                      <span className="small-tag-inner">
                        Threat model
                      </span>
                    </span>
                  </div>
                  <div className="small-tag-wrapper">
                    <span className="small-tag">
                      <span className="small-tag-inner">
                        Assumptions
                      </span>
                    </span>
                  </div>
                </div>
                <div className="positions__item-info mt-sm flex flex-wrap items-center gap-sm transition-all duration-300 lg:group-hover:translate-x-sm">
                  <p className="body-text-s positions__item-location flex items-center gap-[6px]">
                    <span className="block h-full">
                      <img alt="" width={18} height={19} className="select-none" src="/media/location.07aa920e.svg" />
                    </span>
                    From: Loss Bound Certificate
                  </p>
                  <p className="body-text-s positions__item-type flex items-center gap-[6px]">
                    <span className="block h-full">
                      <img alt="" width={18} height={19} className="select-none" src="/media/time.a37b57fa.svg" />
                    </span>
                    Stage: recalculated; stale on change
                  </p>
                </div>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
