import type { ReactNode } from 'react';
import Appear from '../../design/primitives/Appear';

/**
 * One judge card: structural ordinal (from array index, never a metric), title, text, a plate that alternates
 * side and width (7/5 then 5/7), and the action. No symmetric 3-up anywhere.
 */
export default function JudgeCard({
  index,
  side,
  title,
  text,
  tag,
  cta,
  children,
}: {
  index: number;
  side: 'plate-left' | 'plate-right';
  title: string;
  text: string;
  tag?: ReactNode;
  cta?: ReactNode;
  children: ReactNode;
}) {
  const n = String(index + 1).padStart(2, '0');
  return (
    <li className={`sy-jcard sy-jcard--${side}`}>
      <span className="sy-node sy-jcard__node" aria-hidden="true" />
      <div className="sy-jcard__copy">
        <div className="sy-jcard__meta">
          <span className="sy-mono sy-jcard__n">{n}</span>
          {tag}
        </div>
        <Appear role="prose">
          <h2 className="heading-h3 sy-jcard__title">{title}</h2>
          <p className="body-text-m sy-jcard__text">{text}</p>
        </Appear>
        {cta ? <div className="sy-jcard__cta">{cta}</div> : null}
      </div>
      <Appear role="figure" className="sy-jcard__plate">
        {children}
      </Appear>
    </li>
  );
}
