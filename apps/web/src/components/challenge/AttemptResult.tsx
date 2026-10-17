import { CHECK_NAMES, formatBaseUnits, untrusted } from '@symbolon/schemas';
import type { CheckId } from '@symbolon/schemas';
import { UntrustedText } from '../safety/UntrustedText';
import { MiniTag, ModeTag } from '../design/primitives/Tag';
import type { AttemptView, RecordedRow } from './types';

const ACTION_WORD: Record<string, string> = {
  RELEASE: 'Paid',
  HOLD: 'Held',
  ESCALATE: 'Sent to a human',
  REJECT: 'Refused',
  REPLAY: 'Seen before',
  NOOP: 'Nothing moved',
};

const OUTCOME_WORD: Record<string, string> = {
  BLOCKED: 'Blocked',
  ESCALATED: 'Sent to a human',
  HELD: 'Held',
  LOSS: 'Money left wrongly',
  NOOP: 'Nothing moved',
  NOT_RUN: 'Needs the deployed vault',
  'N/A': 'Does not apply',
};

const human = (code: string): string => code.toLowerCase().replace(/_/g, ' ');
const checkName = (id: string): string => (CHECK_NAMES as Record<string, string>)[id as CheckId] ?? '';
const usdc = (base: string): string => `${formatBaseUnits(base, 6)} USDC`;

/** What the oracle says, in a sentence. A loss is rendered as a loss: never softened, never hidden. */
function OracleLine({ lossy, predicates, releases }: { lossy: boolean; predicates: string[]; releases: number }) {
  if (lossy) {
    return (
      <p className="sy-res__oracle" data-loss="true">
        <MiniTag tone="loss">ORACLE: LOSS</MiniTag> Money would reach the wrong place, in the wrong amount, or twice{predicates.length > 0 ? ` (${predicates.join(' + ')})` : ''}.
      </p>
    );
  }
  return (
    <p className="sy-res__oracle">
      <MiniTag tone="solid">ORACLE: NO LOSS</MiniTag> {releases === 0 ? 'Nothing was released.' : 'What was released went to the right payee, in the right amount.'}
    </p>
  );
}

/** One live attempt, as the kernel answered it. Attacker text appears only through <UntrustedText>, as a text node. */
export function LiveAttemptResult({ attempt, title }: { attempt: AttemptView; title?: string }) {
  const r = attempt.result;
  const headline = r.kind === 'oneclick' && r.outcome !== null ? (OUTCOME_WORD[r.outcome] ?? r.outcome) : (ACTION_WORD[r.action] ?? r.action);
  const lossy = r.oracleResult === 'LOSS';
  return (
    <div className="sy-res" data-verdict={r.action} data-loss={lossy ? 'true' : undefined} aria-live="polite">
      <p className="sy-res__meta">
        <ModeTag mode="live" />
        <span className="sy-mono">kernel pipeline · fresh instance · {r.scenarioId}</span>
      </p>
      <h3 className="sy-res__verdict">{headline}</h3>
      {title !== undefined ? <p className="sy-res__title body-text-s">{title}</p> : null}
      {r.kind === 'benign' && r.benign !== null ? (
        <p className="body-text-s">{r.benign.released ? (r.benign.amountMatches === true ? 'It paid, at exactly the right amount.' : 'It paid, but not the amount it should have.') : 'It was not paid. On a benign control that is a false reject, and it is counted.'}</p>
      ) : null}
      {attempt.extractionRefused !== null ? (
        <p className="body-text-s">The reader refused this document ({human(attempt.extractionRefused)}), so nothing reached the kernel&apos;s release path.</p>
      ) : null}
      <OracleLine lossy={lossy} predicates={r.predicates} releases={r.releases} />

      {r.checksFired.length > 0 ? (
        <div className="sy-res__block">
          <p className="sy-mono sy-res__label">Checks that fired</p>
          <ul className="sy-res__chips">
            {r.checksFired.map((c) => (
              <li key={c} className="sy-mini sy-mini--plain">
                {c}
                {checkName(c) !== '' ? ` ${checkName(c)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.reasons.length > 0 ? (
        <div className="sy-res__block">
          <p className="sy-mono sy-res__label">Reason codes</p>
          <ul className="sy-res__chips">
            {r.reasons.map((c) => (
              <li key={c} className="sy-mini sy-mini--dashed">{c}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {r.runs.length > 1 || (r.runs.length === 1 && r.runs[0]?.release !== null) ? (
        <div className="sy-res__block">
          <p className="sy-mono sy-res__label">How the document was read</p>
          <ul className="sy-res__runs">
            {r.runs.map((run) => (
              <li key={run.label}>
                <span className="sy-mono">{run.label}</span>
                <span>{ACTION_WORD[run.action] ?? run.action}</span>
                <span className="sy-mono">{run.release === null ? '—' : `${usdc(run.release.amountBaseUnits)} → ${run.release.oracle.result === 'LOSS' ? 'LOSS' : 'correct payee'}`}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {r.notRun.length > 0 ? (
        <div className="sy-res__block">
          <p className="sy-mono sy-res__label">Not run here</p>
          <ul className="sy-res__notes">
            {r.notRun.map((n) => (
              <li key={n} className="body-text-s">{n}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {attempt.text !== null ? (
        <div className="sy-res__block">
          <p className="sy-mono sy-res__label">Your text ({attempt.text.length} characters)</p>
          <p className="sy-res__quote"><UntrustedText value={untrusted(attempt.text.excerpt)} max={240} /></p>
          <p className="sy-mono sy-res__hash">{attempt.text.hash.slice(0, 18)}…</p>
        </div>
      ) : null}

      {attempt.receipts.length > 0 ? (
        <div className="sy-res__block">
          <p className="sy-mono sy-res__label">Signed receipts</p>
          <ul className="sy-res__notes">
            {attempt.receipts.map((rc) => (
              <li key={rc.receiptHash} className="body-text-s">
                <a className="sy-mono" href={`/audit/${rc.receiptHash}`}>{rc.receiptHash.slice(0, 14)}…</a> <span className="sy-muted">{rc.label}, {rc.verdict.toLowerCase()}</span>
              </li>
            ))}
          </ul>
          <p className="body-text-xs sy-muted">Open one and your browser recomputes its hash and checks the signature. Signed by the sandbox kernel signer; not anchored on-chain in this mode.</p>
        </div>
      ) : null}

      <p className="sy-res__foot sy-muted body-text-s">
        Run on the real kernel code with fixture engagements (placeholder signatures) and simulated evidence; no model reads a one-click attack. This is not an on-chain payment.
      </p>
    </div>
  );
}

/** The recorded fallback for one attack: what the committed attack matrix says about the Warifu target. Always watermarked RECORDED. */
export function RecordedAttemptResult({ id, title, row }: { id: string; title: string; row: RecordedRow | undefined }) {
  const outcome = row?.outcome ?? 'N/A';
  return (
    <div className="sy-res" data-recorded="true" aria-live="polite">
      <p className="sy-res__meta">
        <ModeTag mode="recorded" />
        <span className="sy-mono">committed attack matrix · {id}</span>
      </p>
      <h3 className="sy-res__verdict">{OUTCOME_WORD[outcome] ?? outcome}</h3>
      <p className="sy-res__title body-text-s">{title}</p>
      {row === undefined ? (
        <p className="body-text-s">No recorded row for this attack.</p>
      ) : (
        <>
          <p className="sy-res__oracle">
            <MiniTag tone={row.lossBaseUnits === '0' ? 'solid' : 'loss'}>{row.lossBaseUnits === '0' ? 'ORACLE: NO LOSS' : 'ORACLE: LOSS'}</MiniTag> {row.lossBaseUnits === '0' ? 'No money left in the recorded run.' : `${usdc(row.lossBaseUnits)} left wrongly in the recorded run.`}
          </p>
          {row.checksFired.length > 0 ? (
            <div className="sy-res__block">
              <p className="sy-mono sy-res__label">Checks that fired</p>
              <ul className="sy-res__chips">
                {row.checksFired.map((c) => (
                  <li key={c} className="sy-mini sy-mini--plain">
                    {c}
                    {checkName(c) !== '' ? ` ${checkName(c)}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      <p className="sy-res__foot sy-muted body-text-s">This is a recorded result, not a run you triggered. The live sandbox is not answering, or this attack needs the deployed vault.</p>
    </div>
  );
}
