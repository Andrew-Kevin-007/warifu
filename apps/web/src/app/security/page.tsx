import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ReactNode } from 'react';
import { PageFrame } from '@/components/product/PageFrame';

export const metadata: Metadata = { title: `Security | ${BRAND.name}`, description: 'Good-faith testing terms, scope and how to report a flaw.' };

// SECURITY.md is rendered line by line as text nodes: headings and list items by prefix, everything else a paragraph.
// No markdown-to-HTML conversion is used, so no file content can become markup (INV-15).
function render(md: string): ReactNode[] {
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length > 0) {
      const items = list;
      out.push(<ul key={`ul-${out.length}`} className="sy-list">{items.map((t, i) => <li key={i}>{strip(t)}</li>)}</ul>);
      list = [];
    }
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('- ')) { list.push(line.slice(2)); continue; }
    flush();
    if (line.trim() === '') continue;
    if (line.startsWith('## ')) out.push(<h2 key={out.length} className="heading-h5 sy-section">{strip(line.slice(3))}</h2>);
    else if (line.startsWith('# ')) continue;
    else if (line.startsWith('> ')) out.push(<p key={out.length} className="sy-banner">{strip(line.slice(2))}</p>);
    else out.push(<p key={out.length} style={{ marginTop: 8 }}>{strip(line)}</p>);
  }
  flush();
  return out;
}

const strip = (s: string): string => s.replace(/[*_`]/g, '');

export default function Page() {
  let body: ReactNode[];
  try {
    body = render(readFileSync(join(resolve(process.cwd(), '..', '..'), 'SECURITY.md'), 'utf8'));
  } catch {
    body = [<p key="x">The security policy file is not available in this deployment.</p>];
  }
  return (
    <PageFrame eyebrow="Security" title="Testing terms and disclosure" lede="Scope, rules and how to report a real flaw.">
      {body}
    </PageFrame>
  );
}
