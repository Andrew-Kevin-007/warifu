export default function SectionFeaturesGrid() {
  return (
    <section className="section-features-grid my-80px lg:mb-xs lg:mt-64px overflow-hidden">
      <div className="container">
        <div className="section-features-grid__wrapper mx-auto grid max-w-[1024px] grid-cols-1 gap-xxl lg:grid-cols-2 lg:gap-x-xxs lg:gap-y-sm">
          <div className="section-features-grid__card flex flex-col gap-sm lg:gap-md">
            <div className="section-features-grid__card-image select-none">
              <span className="block h-full">
                <img alt="" width={512} height={331} className="" src="/media/disruptive-agentic-integrations.b6f08a9a.svg" />
              </span>
            </div>
            <p className="body-text-m mx-md lg:mx-xl lg:mb-xl" style={{maxWidth: "320px"}}>
              A familiar channel does not prove who should be paid. The kernel checks the payee, evidence and signed terms.
            </p>
          </div>
          <div className="section-features-grid__card flex flex-col gap-sm lg:gap-md">
            <div className="section-features-grid__card-image select-none">
              <span className="block h-full">
                <img alt="" width={512} height={331} className="" src="/media/x-profile.ef64f7b7.svg" />
              </span>
            </div>
            <p className="body-text-m mx-md lg:mx-xl lg:mb-xl" style={{maxWidth: "356px"}}>
              A familiar sender is not proof of the payee. The signed engagement binds the payout address.
            </p>
          </div>
          <div className="section-features-grid__card flex flex-col gap-sm lg:gap-md">
            <div className="section-features-grid__card-image select-none">
              <span className="block h-full">
                <img alt="" width={512} height={307} className="" src="/media/proof-of-intelligence.9f65e16a.svg" />
              </span>
            </div>
            <p className="body-text-m mx-md lg:mx-xl lg:mb-xl" style={{maxWidth: "414px"}}>
              Every release leaves a signed receipt tied to the vault event, so the decision can be checked after the fact.
            </p>
          </div>
          <div className="section-features-grid__card flex flex-col gap-sm lg:gap-md">
            <div className="section-features-grid__card-image select-none">
              <span className="block h-full">
                <img alt="" width={512} height={307} className="" src="/media/conversational-and-documented-RAG.90cabc3a.svg" />
              </span>
            </div>
            <p className="body-text-m mx-md lg:mx-xl lg:mb-xl" style={{maxWidth: "414px"}}>
              The audit record keeps the checks and reason codes inspectable alongside the verdict.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
