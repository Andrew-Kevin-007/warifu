import type { Metadata } from 'next';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ReactNode } from 'react';
import { BRAND } from '@/lib/brand';
import SecurityBody from '@/components/pages/security/SecurityBody';

export const metadata: Metadata = { title: `Security | ${BRAND.name}`, description: 'Good-faith testing terms, scope and how to report a flaw.' };

// SECURITY.md is rendered line by line as text nodes: headings and list items by prefix, everything else a paragraph. No
// markdown-to-HTML conversion is used, so no file content can become markup (INV-15). Headings get anchors for the table of contents.
const strip = (s: string): string => s.replace(/[*_`]/g, '');
const slug = (s: string): string => strip(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

function render(md: string): { prose: ReactNode[]; toc: { id: string; title: string }[] } {
  const out: ReactNode[] = [];
  const toc: { id: string; title: string }[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length > 0) {
      const items = list;
      out.push(<ul key={`ul-${out.length}`}>{items.map((t, i) => <li key={i}>{strip(t)}</li>)}</ul>);
      list = [];
    }
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('- ')) { list.push(line.slice(2)); continue; }
    flush();
    if (line.trim() === '') continue;
    if (line.startsWith('## ')) {
      const title = strip(line.slice(3));
      const id = slug(title);
      toc.push({ id, title });
      out.push(<h2 key={out.length} id={id}>{title}</h2>);
    } else if (line.startsWith('# ')) continue;
    else if (line.startsWith('> ')) out.push(<p key={out.length}><em>{strip(line.slice(2))}</em></p>);
    else out.push(<p key={out.length}>{strip(line)}</p>);
  }
  flush();
  return { prose: out, toc };
}

export default function Page() {
  let r: { prose: ReactNode[]; toc: { id: string; title: string }[] };
  try {
    r = render(readFileSync(join(resolve(process.cwd(), '..', '..'), 'SECURITY.md'), 'utf8'));
  } catch {
    r = { prose: [<p key="x">The security policy file is not available in this deployment.</p>], toc: [] };
  }
  return <SecurityBody model={{ title: 'Attack us, in good faith.', toc: r.toc, prose: <>{r.prose}</> }} />;
}
