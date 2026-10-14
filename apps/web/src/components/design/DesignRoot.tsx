import type { ReactNode } from 'react';
import type { Mode, Profile } from './types';
import '../../styles/design.css';
import '../../styles/design-motion.css';
import '../../styles/design-pages.css';
import '../../styles/lane-skin.css';

/**
 * Wrap every page body in this. It loads the design tokens (all under the `.sy-` / `--sy-` prefix; nothing
 * global is restyled), sets the mode/profile attributes the CSS keys on, and installs the designed focus ring.
 * `recorded`/`simulated`/`fixture`/`demo` set data-sy-frozen: recorded things are still (no idle motion).
 */
export default function DesignRoot({
  mode = 'live',
  profile = 'app',
  children,
  className = '',
}: {
  mode?: Mode;
  profile?: Profile;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`sy-root ${className}`.trim()}
      data-sy-mode={mode}
      data-sy-profile={profile}
      data-sy-frozen={mode === 'live' ? undefined : 'true'}
    >
      {children}
    </div>
  );
}
