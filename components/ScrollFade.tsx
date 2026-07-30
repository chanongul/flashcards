"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ScrollFadeProps {
  children: React.ReactNode;
  // Matches whatever the fade needs to blend into — defaults to the review
  // page's card box (bg-neutral-900); the list pages (all/browse cards),
  // which sit directly on the page background instead of inside a bordered
  // card box, pass fadeFrom="from-neutral-950" instead.
  fadeFrom?: string;
  // The review page's card box has px-4 padding, so the fade bleeds 1rem
  // past this wrapper's own edges (-left-4/-right-4) to reach the card's
  // true left/right border rather than stopping at the padded content area.
  // The list pages have no such padded box to bleed through, so they pass
  // bleed={false} to just span this wrapper's own width (inset-x-0).
  bleed?: boolean;
  extraSide?: boolean;
  // Merged onto the root wrapper (the flex-1 box, not the inner scroller) —
  // e.g. a negative right margin to bleed this whole region out past an
  // ancestor's own padding, so the browser's scrollbar renders flush with
  // the page's true edge instead of inset inside that padding. Pair with
  // padding on your own children to keep the actual content visually inset
  // the way it was before (the scrollbar sits in the gap between).
  className?: string;
}

/** A vertical scroll region that shows a faded gradient at the top and/or
 * bottom edge whenever there's more content to scroll to in that direction —
 * a hint that the content is clipped. The fades sit outside the scroll area
 * (pinned, pointer-events-none) so they don't scroll or block interaction. */
export function ScrollFade({
  children,
  fadeFrom = "from-neutral-900",
  bleed = true,
  extraSide = false,
  className = "",
}: ScrollFadeProps) {
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
    // No w-full here on purpose — an explicit width:100% would win out over
    // flexbox's own stretch sizing and stop a negative margin (passed via
    // className, see the prop doc above) from actually widening the box;
    // plain flex-1 stretch sizing (the default cross-axis behavior in a
    // flex-col parent) already computes the same 100%-of-available-space
    // width when no such margin is present, so this is a no-op change for
    // every other existing usage.
    <div className={`relative min-h-0 flex-1 ${className}`}>
      <div
        ref={ref}
        onScroll={update}
        className={`h-full overflow-y-auto ${
          extraSide
            ? `w-[calc(100%+0.5rem)] -mx-1`
            : ""
        }`}
      >
        {children}
      </div>
      <div
        aria-hidden
        className={`pointer-events-none absolute ${bleed ? "-left-4 -right-4" : "inset-x-0"} top-0 h-8 bg-gradient-to-b ${fadeFrom} to-transparent transition-opacity duration-150 ${
          showTop ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute ${bleed ? "-left-4 -right-4" : "inset-x-0"} bottom-0 h-8 bg-gradient-to-t ${fadeFrom} to-transparent transition-opacity duration-150 ${
          showBottom ? "opacity-100" : "opacity-0"
        }`}
      />
    </div>
  );
}
