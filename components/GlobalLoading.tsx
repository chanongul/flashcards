'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

interface LoadingContextValue {
  begin: () => void;
  end: () => void;
  /** Runs an async create/edit action, showing the global loading bar for
   * its duration. A counter (not a boolean) so overlapping actions from
   * different forms don't hide the bar early when only one finishes. */
  withLoading: <T>(fn: () => Promise<T> | T) => Promise<T>;
}

const LoadingContext = createContext<LoadingContextValue | null>(null);

export function LoadingProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);

  const begin = useCallback(() => setCount((c) => c + 1), []);
  const end = useCallback(() => setCount((c) => c - 1), []);

  const withLoading = useCallback(
    async <T,>(fn: () => Promise<T> | T): Promise<T> => {
      begin();
      try {
        return await fn();
      } finally {
        end();
      }
    },
    [begin, end]
  );

  return (
    <LoadingContext.Provider value={{ begin, end, withLoading }}>
      {children}
      {count > 0 && (
        <div className="fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden bg-neutral-800">
          <div className="h-full w-1/3 bg-neutral-100 [animation:loading-bar-slide_1s_ease-in-out_infinite]" />
        </div>
      )}
    </LoadingContext.Provider>
  );
}

export function useLoading(): LoadingContextValue {
  const ctx = useContext(LoadingContext);
  if (!ctx) throw new Error('useLoading must be used inside LoadingProvider');
  return ctx;
}

/** Drives the global loading bar from a plain boolean condition (a page's
 * own `loading` state) instead of wrapping a one-off async action — for
 * replacing a page-level "Loading…" placeholder with the same indicator
 * used for create/edit actions. */
export function useLoadingWhen(active: boolean): void {
  const { begin, end } = useLoading();
  useEffect(() => {
    if (!active) return;
    begin();
    return end;
  }, [active, begin, end]);
}
