'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface ScrollFadeProps {
  children: React.ReactNode;
}

/** A vertical scroll region that shows a faded gradient at the top and/or
 * bottom edge whenever there's more content to scroll to in that direction —
 * a hint that the content is clipped. The fades sit outside the scroll area
 * (pinned, pointer-events-none) so they don't scroll or block interaction.
 * Gradient fades to the card's background (neutral-950). */
export function ScrollFade({ children }: ScrollFadeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false);
  const [showBottom, setShowBottom] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setShowTop(el.scrollTop > 1);
    setShowBottom(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    // Recompute when the container is resized (viewport change, revealing the
    // answer) or when its content changes size (new card, longer/shorter text).
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [update]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={update} className="h-full overflow-y-auto overflow-x-hidden">
        {children}
      </div>
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-neutral-950 to-transparent transition-opacity duration-150 ${
          showTop ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-neutral-950 to-transparent transition-opacity duration-150 ${
          showBottom ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </div>
  );
}
