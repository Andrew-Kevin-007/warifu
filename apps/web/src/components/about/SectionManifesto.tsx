import { BRAND } from '@/lib/brand';
export default function SectionManifesto() {
  return (
    <section className="section-manifesto pb-80px pt-120px lg:pb-[102px] lg:pt-[142px] overflow-hidden" id="manifesto">
      <div className="container">
        <div className="section-manifesto__heading mx-auto mb-64px flex max-w-[629px] flex-col items-center gap-[4px] text-center">
          <p className="body-text-s">
            About {BRAND.name}
          </p>
          <h1 className="heading-hero">
            A payment request can lie.
          </h1>
        </div>
        <div className="section-manifesto__wrapper">
          <div className="image-text flex flex-col gap-80px lg:gap-120px">
            <div className="image-text__wrapper mx-auto lg:max-w-[760px]">
              <div className="image-text__item flex flex-col gap-xl lg:items-center lg:justify-between lg:flex-row-reverse">
                <div className="image-text__image select-none lg:basis-[320px]">
                  <span className="block h-full">
                    <img alt="Abstract barcode-like document carried in a cloud-shaped vessel" width={960} height={1575} className="" src="/media/manifesto-image.734e022c.png" />
                  </span>
                </div>
                <div className="image-text__info flex flex-col gap-md lg:max-w-[320px]">
                  <p className="body-text-m image-text__paragraph">
                    An invoice is untrusted input, even when it looks ordinary. A changed payout address, a duplicate retry, a decimal error or hidden instructions can turn a routine request into an attack.
                  </p>
                  <p className="body-text-m image-text__paragraph">
                    Extraction turns the invoice into candidate fields, not verified facts. The agreement and independently gathered evidence establish whether the request is authorized.
                  </p>
                  <p className="body-text-m image-text__paragraph">
                    {BRAND.name} is a treasury control layer for agent-driven USDC payments on Arc. Each decision is reason-coded and can be checked afterward.
                  </p>
                  <p className="body-text-m image-text__paragraph">
                    The system makes model errors visible and limits their impact under stated assumptions.
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
