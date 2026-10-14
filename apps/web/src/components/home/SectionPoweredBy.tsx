export default function SectionPoweredBy() {
  return (
    <section className="section-powered-by my-80px lg:my-64px overflow-hidden">
      <div className="container">
        <div className="logos-line flex w-full flex-col items-center gap-sm overflow-hidden">
          <p className="body-text-m logos-line__title text-center text-gray-900">
            A model can suggest a payee. It cannot authorize the payment.
          </p>
          <div className="logos-line__wrapper grid w-full grid-cols-2 items-center justify-center gap-xs sm:grid-cols-3 lg:flex lg:flex-row lg:gap-md">
            <div className="logos-line__item flex justify-center">
              <span className="block h-full">
                <img alt="OpenAI" width={160} height={58} className="select-none w-[160px]" src="/media/openai.4a099e6d.svg" />
              </span>
            </div>
            <div className="logos-line__item flex justify-center">
              <span className="block h-full">
                <img alt="DeepSeek" width={160} height={58} className="select-none w-[160px]" src="/media/deepseek.7739d1b7.svg" />
              </span>
            </div>
            <div className="logos-line__item flex justify-center">
              <span className="block h-full">
                <img alt="Claude" width={160} height={58} className="select-none w-[160px]" src="/media/claude.159e5cc5.svg" />
              </span>
            </div>
            <div className="logos-line__item flex justify-center">
              <span className="block h-full">
                <img alt="Anthropic" width={160} height={58} className="select-none w-[160px]" src="/media/anthropic.df8fb2b8.svg" />
              </span>
            </div>
            <div className="logos-line__item flex justify-center">
              <span className="block h-full">
                <img alt="Gemini" width={160} height={58} className="select-none w-[160px]" src="/media/gemini.652c86da.svg" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
