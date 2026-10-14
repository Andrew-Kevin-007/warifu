import type { CertificateView as View } from '@symbolon/blast-radius/lbc';
import { Chip, Section } from './PageFrame';
import type { ChipTone } from './PageFrame';

const TONE: Record<string, ChipTone> = { VALID: 'pass', STALE: 'warn', UNVERIFIED: 'muted', MISMATCH: 'fail' };

/**
 * docs/16 section 7 order: exclusions first, then the generated headline, the status chip, horizons, assumptions,
 * validation, the verify command and (when STALE or MISMATCH) the diff. Every string comes from certificateView().
 */
export function CertificateBody({ view, source }: { view: View; source: 'LIVE' | 'RECORDED' }) {
  const stale = view.status.label === 'STALE' || view.status.label === 'MISMATCH';
  return (
    <>
      <Section title="What this does not cover" id="exclusions">
        <ul className="sy-list">
          {view.exclusions.map((x) => (
            <li key={x.id}>
              <span className="sy-mono">{x.id}</span> {x.text}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Bound">
        <div className="sy-card">
          <p className="heading-h6">{view.headline}</p>
          <p className="body-text-s" style={{ marginTop: 12 }}>{view.alarmed}</p>
          <p style={{ marginTop: 12 }}>
            <Chip tone={TONE[view.status.label] ?? 'muted'}>{view.status.label}</Chip>{' '}
            <Chip>{source}</Chip>{' '}
            <span className="body-text-s">
              {view.status.reasons.length > 0 ? `reasons: ${view.status.reasons.join(', ')}` : 'no reasons recorded'}
            </span>
          </p>
        </div>
      </Section>

      <Section title="Horizons">
        <div className="sy-table-wrap">
          <table className="sy-table">
            <thead><tr><th>Horizon</th><th>At most</th><th>Binding terms</th></tr></thead>
            <tbody>
              {view.horizons.map((h) => (
                <tr key={h.label}>
                  <td>{h.label}</td>
                  <td>{h.valueDisplay}</td>
                  <td className="sy-mono">{h.binding.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Assumptions">
        <ul className="sy-list">
          {view.assumptions.map((a) => (
            <li key={a.id}>
              <span className="sy-mono">{a.id}</span> {a.text}
            </li>
          ))}
        </ul>
        {view.notes.length > 0 ? (
          <ul className="sy-list" style={{ marginTop: 12 }}>
            {view.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Validation">
        <p>{view.validation.sentence}</p>
      </Section>

      <Section title="Recompute it yourself">
        <pre className="sy-pre">{view.verifyCommand}</pre>
        <p className="body-text-s">
          Exit codes: 0 VALID, 10 STALE, 20 UNVERIFIED. As of block {view.asOf.blockNumber}; certificate hash <span className="sy-mono">{view.certHash}</span>.
        </p>
      </Section>

      {stale ? (
        <Section title="What changed">
          {view.diff.length === 0 ? (
            <p>The certificate no longer matches on-chain state; no field diff is available.</p>
          ) : (
            <div className="sy-table-wrap">
              <table className="sy-table">
                <thead><tr><th>Field</th><th>Certificate says</th><th>Recomputed</th></tr></thead>
                <tbody>
                  {view.diff.map((d) => (
                    <tr key={d.path}>
                      <td className="sy-mono">{d.path}</td>
                      <td className="sy-mono">{d.document}</td>
                      <td className="sy-mono">{d.recomputed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      ) : null}
    </>
  );
}
