'use client';

import { useRouter } from 'next/navigation';

/** A "back" button that behaves like one: goes to the actual previous
 * history entry instead of always pushing a fresh one onto a fixed parent
 * path, which stacked up redundant entries every time (repeatedly opening
 * the same deck's browse page, then hitting back, kept growing the stack
 * instead of unwinding it). Falls back to replacing with `fallbackHref`
 * when there's nothing to go back to within this tab (a fresh PWA launch
 * or a reloaded/deep-linked page, where history.length is 1) — router.back()
 * there would do nothing, or leave the app entirely. Replace, not push,
 * so landing on the fallback doesn't itself become a dead-end forward
 * entry sitting in front of whatever's actually behind it. */
export function useSmartBack(fallbackHref: string) {
  const router = useRouter();
  return () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.replace(fallbackHref);
    }
  };
}
