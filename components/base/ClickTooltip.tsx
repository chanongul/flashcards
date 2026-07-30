'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ClickTooltipProps {
  text: string;
  anchorRect: AnchorRect;
  onDismiss: () => void;
}

const TOOLTIP_MARGIN = 8;
const TOOLTIP_GAP = 6;

/** A small portal-rendered tooltip anchored to a clicked element's bounding
 * rect, clamped to stay fully on-screen, dismissed on any outside click/
 * scroll/resize — the same interaction ReviewHeatmap's day-cell tooltips
 * use, pulled out here so other click-to-reveal-full-text spots (e.g. a
 * truncated deck name) can reuse the position/dismiss logic instead of
 * re-deriving it. The caller owns *when* to show one (including toggling
 * the same trigger closed again); this only positions and dismisses it. */
export function ClickTooltip({ text, anchorRect, onDismiss }: ClickTooltipProps) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Positioned after render, once we know the tooltip's real size, so it can
  // be clamped to stay on-screen instead of running off an edge.
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    let left = anchorRect.left + (anchorRect.right - anchorRect.left) / 2 - rect.width / 2;
    left = Math.min(Math.max(left, TOOLTIP_MARGIN), window.innerWidth - rect.width - TOOLTIP_MARGIN);
    let top = anchorRect.top - rect.height - TOOLTIP_GAP;
    if (top < TOOLTIP_MARGIN) top = anchorRect.bottom + TOOLTIP_GAP; // not enough room above — flip below
    setPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorRect.left, anchorRect.top, anchorRect.right, anchorRect.bottom, text]);

  useEffect(() => {
    // mousedown/touchstart (not click) so this beats the trigger's own click
    // handler to the punch — the trigger decides whether re-clicking itself
    // should toggle a new tooltip open right after this closes the old one.
    const onPointerDown = () => onDismiss();
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('mousedown', onPointerDown);
    // capture:true so this still fires for scrolls inside a nested
    // overflow-y-auto region, which wouldn't otherwise bubble to window.
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [onDismiss]);

  return createPortal(
    <div
      ref={ref}
      style={{
        left: pos?.left ?? anchorRect.left,
        top: pos?.top ?? anchorRect.top,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="pointer-events-none fixed z-[60] max-w-[calc(100vw-16px)] whitespace-nowrap rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-100 shadow-lg"
    >
      {text}
    </div>,
    document.body
  );
}
