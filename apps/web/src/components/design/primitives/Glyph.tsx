import type { GlyphKind } from '../runtime/states';

// 14 px status glyphs. Status is never colour-only: every chip carries one of these plus its word.
// Drawn with currentColor so a glyph inherits the chip's text colour (and its contrast).
export default function Glyph({ kind, className = '' }: { kind: GlyphKind; className?: string }) {
  const cls = `sy-glyph ${className}`.trim();
  switch (kind) {
    case 'joined':
      return (
        <svg className={cls} viewBox="0 0 14 14" width={14} height={14} aria-hidden="true" focusable="false">
          <path d="M7 1.5a5.5 5.5 0 0 0 0 11V1.5Z" fill="currentColor" />
          <path d="M7 1.5a5.5 5.5 0 0 1 0 11V1.5Z" fill="currentColor" />
          <path d="M7 1.5v3h-1.5v3H7v3h-1.5v2" fill="none" stroke="#fff" strokeWidth="0.9" />
        </svg>
      );
    case 'offset':
      return (
        <svg className={cls} viewBox="0 0 14 14" width={14} height={14} aria-hidden="true" focusable="false">
          <path d="M6.2 1.5a5.5 5.5 0 0 0 0 11V1.5Z" fill="currentColor" transform="translate(-0.8 -1)" />
          <path d="M7.8 1.5a5.5 5.5 0 0 1 0 11V1.5Z" fill="currentColor" transform="translate(0.8 1)" />
        </svg>
      );
    case 'open':
      return (
        <svg className={cls} viewBox="0 0 14 14" width={14} height={14} aria-hidden="true" focusable="false">
          <path d="M6 1.5a5.5 5.5 0 0 0 0 11V1.5Z" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 1.5" />
          <path d="M8 1.5a5.5 5.5 0 0 1 0 11V1.5Z" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 1.5" />
        </svg>
      );
    case 'frozen':
      return (
        <svg className={cls} viewBox="0 0 14 14" width={14} height={14} aria-hidden="true" focusable="false">
          <rect x="2" y="2" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <rect x="5" y="5" width="4" height="4" fill="currentColor" />
        </svg>
      );
    case 'hatch':
      return (
        <svg className={cls} viewBox="0 0 14 14" width={14} height={14} aria-hidden="true" focusable="false">
          <rect x="2" y="2" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1" />
          <path d="M2 8 8 2M2 12 12 2M6 12 12 6M10 12 12 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      );
    case 'dot':
      return (
        <svg className={cls} viewBox="0 0 14 14" width={14} height={14} aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="3" fill="#9280FC" className="sy-pulse" />
        </svg>
      );
    case 'loss':
      return (
        <svg className={cls} viewBox="0 0 14 14" width={14} height={14} aria-hidden="true" focusable="false">
          <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case 'fixture':
      return (
        <svg className={cls} viewBox="0 0 14 14" width={14} height={14} aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" />
        </svg>
      );
    default: {
      const never: never = kind;
      return never;
    }
  }
}
