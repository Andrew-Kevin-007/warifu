// What the product is actually built on, as plain text (no logos: a mark would imply a partnership we do not have).
const BUILT_ON: readonly { name: string; role: string }[] = [
  { name: 'Arc', role: 'chain, USDC as gas' },
  { name: 'USDC', role: 'what the vault holds and pays' },
  { name: 'Circle wallets', role: 'transaction relayer' },
  { name: 'Claude', role: 'reads invoices; advisory only' },
  { name: 'viem + Foundry', role: 'chain access and contract tests' },
];

export default function SectionPoweredBy() {
  return (
    <section className="section-powered-by my-80px lg:my-64px overflow-hidden">
      <div className="container">
        <div className="logos-line flex w-full flex-col items-center gap-sm overflow-hidden">
          <p className="body-text-m logos-line__title text-center text-gray-900">
            A model can suggest a payee. It cannot authorize the payment.
          </p>
          <ul className="logos-line__wrapper grid w-full grid-cols-2 items-center justify-center gap-xs sm:grid-cols-3 lg:flex lg:flex-row lg:gap-md">
            {BUILT_ON.map((b) => (
              <li key={b.name} className="logos-line__item flex flex-col items-center text-center">
                <span className="font-primary text-20 font-medium tracking-tight">{b.name}</span>
                <span className="body-text-xs text-gray-900">{b.role}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
