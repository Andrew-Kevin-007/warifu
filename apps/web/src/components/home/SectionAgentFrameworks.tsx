import Link from 'next/link';

// The path every payment takes, whichever agent proposed it. No third-party marks: they would imply integrations we do not have.
const STEPS: readonly { title: string; text: string; href: string }[] = [
  { title: 'Proposal', text: 'An agent or an invoice extractor suggests a payee and an amount. Nothing is paid yet.', href: '/docs' },
  { title: 'Signed terms', text: 'Signed terms bind the payee, budget cap and milestones.', href: '/docs' },
  { title: 'Kernel checks', text: 'The kernel checks evidence, policy, balances and history.', href: '/security' },
  { title: 'Re-check at release', text: 'Fresh state is checked again at release time.', href: '/docs' },
  { title: 'Vault', text: 'The vault applies the cap and prevents a second release.', href: '/certificate' },
];

export default function SectionAgentFrameworks() {
  return (
    <section className="section-agent-frameworks my-80px lg:my-xxl overflow-hidden">
      <div className="container">
        <div className="section-agent-frameworks__heading mx-auto mb-md flex max-w-[610px] flex-col items-center gap-sm text-center lg:mb-[57px]">
          <h4 className="heading-h1 gradient-text-black leading-130">
            One payment gate for every agent stack.
          </h4>
          <p className="subtitle-s section-agent-frameworks__text mx-auto max-w-[510px]">
            Any agent stack plugs in the same way: it sends a proposal, and the gate decides. Evidence, signed terms, policy, balances and history are checked before a vault release.
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
              {STEPS.map((step, i) => (
                <Link key={step.title} className="frameworks__item group border-b-[0.5px] border-dashed border-[#CCCCCC] py-[20px] last:border-b-0" href={step.href}>
                  <div className="frameworks__item-heading flex items-center justify-between gap-sm">
                    <div className="flex flex-1 items-center gap-xs transition-all duration-300 lg:group-hover:translate-x-xs">
                      <span className="sy-mono block w-md select-none text-gray-900" aria-hidden="true">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <p className="flex-1 font-primary text-20 font-medium leading-100 tracking-tight">{step.title}</p>
                    </div>
                  </div>
                  <p className="body-text-s frameworks__item-description mt-[10px] text-gray-1000 transition-all duration-300 lg:max-w-[267px] lg:group-hover:translate-x-xs">
                    {step.text}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
