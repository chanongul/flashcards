'use client';

import { useEffect } from 'react';

let lockCount = 0;

/** Prevents the page behind a modal from scrolling while it's open.
 * Reference-counted so multiple simultaneously-active locks (e.g. a confirm
 * dialog opened on top of another modal) don't unlock each other early.
 * Locks documentElement (html), not just body — html has its own explicit
 * overflow-x in globals.css, which disables the browser's usual "body's
 * overflow governs the viewport" propagation, making html itself
 * `document.scrollingElement` here. Locking only body silently did nothing. */
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    lockCount++;
    if (lockCount === 1) {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
    }
    return () => {
      lockCount--;
      if (lockCount === 0) {
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
      }
    };
  }, [active]);
}
