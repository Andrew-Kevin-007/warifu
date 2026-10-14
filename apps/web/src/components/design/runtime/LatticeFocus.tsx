'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface LatticeFocusValue {
  /** The attack column currently highlighted (hover/focus of a table row or a lattice column), or null. */
  attackId: string | null;
  setAttackId: (id: string | null) => void;
}

const Ctx = createContext<LatticeFocusValue>({ attackId: null, setAttackId: () => undefined });

/**
 * Shared column lock between the lattice (a skin) and the matrix table (the real control).
 * Keyboard users drive it by focusing a table row; pointer users by hovering either one.
 */
export function LatticeFocusProvider({ children }: { children: ReactNode }) {
  const [attackId, set] = useState<string | null>(null);
  const setAttackId = useCallback((id: string | null) => set(id), []);
  const value = useMemo(() => ({ attackId, setAttackId }), [attackId, setAttackId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLatticeFocus(): LatticeFocusValue {
  return useContext(Ctx);
}
