// Exit codes are the documented contract of `pnpm lbc verify` (docs/16 section 5), not metrics.
const EXIT_CODES: { code: string; word: string; text: string }[] = [
  { code: '0', word: 'Valid', text: 'Recomputed and equal.' },
  { code: '10', word: 'Stale', text: 'The configuration changed since the certificate was computed.' },
  { code: '30', word: 'Mismatch', text: 'The recomputation differs from the document.' },
];

/** The command in a black plate. Behaviour (copy) belongs to the lane; this is the skin. */
export default function VerifyBlock({ command }: { command: string }) {
  return (
    <section className="sy-verify container" data-sy-section="verify" aria-label="Verify it yourself">
      <h2 className="heading-h4">Verify it yourself</h2>
      <p className="body-text-m sy-muted sy-verify__lede">
        Run this against your own RPC. You never need to trust our server, our signature or this page.
      </p>
      <div className="sy-cmd sy-on-black">
        <code>{command}</code>
      </div>
      <ul className="sy-verify__codes" aria-label="Exit codes">
        {EXIT_CODES.map((c) => (
          <li key={c.code}>
            <span className="sy-mono sy-verify__code">{c.code}</span>
            <span className="sy-verify__word">{c.word}</span>
            <span className="body-text-s sy-muted">{c.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
