'use client';

import { useState, type ReactNode } from 'react';
import { utf8Length } from '../../design/runtime/format';

/**
 * "Write your own": text area with a byte counter and a scenario selector. State is local and ephemeral (no
 * storage, no network). The lane receives `onSubmit` and does everything real, including the CAPTCHA, which
 * arrives as a slot. The text is untrusted input and is never echoed anywhere by the kit.
 */
export default function WriteYourOwnPlate({
  maxBytes,
  scenarios,
  captcha,
  disabled = false,
  onSubmit,
  afterScenario,
}: {
  maxBytes: number;
  scenarios: { id: string; label: string }[];
  captcha?: ReactNode;
  disabled?: boolean;
  onSubmit?: (v: { text: string; scenarioId: string }) => void;
  /** A control that depends on the chosen scenario (the lane's milestone picker), rendered right under the scenario selector. */
  afterScenario?: (scenarioId: string) => ReactNode;
}) {
  const [text, setText] = useState('');
  const [scenario, setScenario] = useState(scenarios[0]?.id ?? '');
  const bytes = utf8Length(text);
  const over = bytes > maxBytes;

  return (
    <form
      className="sy-write"
      onSubmit={(e) => {
        e.preventDefault();
        if (!over && text.length > 0 && onSubmit) onSubmit({ text, scenarioId: scenario });
      }}
    >
      <fieldset className="sy-write__scenarios">
        <legend className="sy-mono">Scenario</legend>
        <div className="sy-write__seg" role="radiogroup" aria-label="Scenario">
          {scenarios.map((s) => (
            <label key={s.id} className="sy-write__opt" data-on={scenario === s.id ? 'true' : undefined}>
              <input type="radio" name="scenario" value={s.id} checked={scenario === s.id} onChange={() => setScenario(s.id)} />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {afterScenario ? afterScenario(scenario) : null}
      <label className="sy-write__field">
        <span className="sy-mono">Invoice text</span>
        <textarea
          className="sy-write__ta"
          rows={7}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-describedby="sy-write-count"
        />
      </label>
      <div className="sy-write__row">
        <p id="sy-write-count" className="sy-mono sy-write__count" data-over={over ? 'true' : undefined} aria-live="polite">
          {utf8Length(text)} / {maxBytes} bytes
        </p>
        {captcha}
      </div>
      <span className="button-primary-m__wrapper sy-write__submit">
        <button type="submit" className="button-primary-m" disabled={disabled || over || text.length === 0 || !onSubmit}>
          <span className="block">Submit attempt</span>
        </button>
      </span>
    </form>
  );
}
