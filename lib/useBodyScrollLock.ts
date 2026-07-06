'use client';

import { useEffect } from 'react';

let lockCount = 0;

/** Prevents the page behind a modal from scrolling while it's open.
 * Reference-counted so multiple simultaneously-active locks (e.g. a confirm
 * dialog opened on top of another modal) don't unlock each other early. */
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    lockCount++;
    if (lockCount === 1) document.body.style.overflow = 'hidden';
    return () => {
      lockCount--;
      if (lockCount === 0) document.body.style.overflow = '';
    };
  }, [active]);
}
