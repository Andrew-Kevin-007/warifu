export default function SectionAcceleration() {
  return (
    <section className="section-acceleration relative py-80px lg:pb-80px lg:pt-[104px] overflow-hidden" id="acceleration-program">
      <div className="container">
        <div className="section-top-shadow" />
        <div className="section-manifesto__heading mx-auto mb-64px flex max-w-[680px] flex-col items-center gap-[4px] text-center">
          <p className="body-text-s">
            The Control Layer
          </p>
          <h2 className="heading-h1">
            A signed agreement stays in charge.
          </h2>
        </div>
        <div className="section-acceleration__wrapper">
          <div className="image-text flex flex-col gap-80px lg:gap-120px">
            <div className="image-text__wrapper mx-auto lg:max-w-[760px]">
              <div className="image-text__item flex flex-col gap-xl lg:items-center lg:justify-between lg:flex-row">
                <div className="image-text__image select-none lg:basis-[320px]">
                  <span className="block h-full">
                    <img alt="Purple core enclosed in a transparent, vault-like structure" width={960} height={1575} className="" src="/media/acceleration-image.7fdc5e9e.png" />
                  </span>
                </div>
                <div className="image-text__info flex flex-col gap-md lg:max-w-[320px]">
                  <p className="body-text-m image-text__paragraph">
                    Before an invoice arrives, the owner and payee co-sign an engagement. It fixes the authorized address, budget cap, milestones, evidence requirements and payment window.
                  </p>
                  <p className="body-text-m image-text__paragraph">
                    Invoice extraction cannot rewrite those terms. Evidence is collected separately, and the kernel compares the proposed payment with the agreement and current policy.
                  </p>
                  <p className="body-text-m image-text__paragraph">
                    If owner approval is needed, the signing screen shows the actual recipient and amount. The scheduler then rechecks fresh context before the vault accepts an attestation.
                  </p>
                  <h3 className="heading-h6 image-text__paragraph gradient-text-soon">
                    Every limit is an explicit rule, not a model suggestion.
                  </h3>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
