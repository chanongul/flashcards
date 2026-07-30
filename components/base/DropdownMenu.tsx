'use client';

import { useEffect, useRef, useState } from 'react';
import { shouldDropUp, nearestScrollContainer } from '@/lib/dropdownMenu';

interface DropdownMenuProps {
  // Render prop, not a fixed icon+style: some triggers (e.g. a deck row's
  // "..." button) carry extra handlers of their own (a press-hold gesture)
  // layered onto the same element, so the caller needs to own the JSX.
  trigger: (props: { onClick: (e: React.MouseEvent<HTMLElement>) => void; open: boolean }) => React.ReactNode;
  // Render prop receiving close() so each item can close the menu itself
  // after acting, the same way every call site already does today —
  // works uniformly whether an item is a <button> or a <Link>.
  children: (close: () => void) => React.ReactNode;
  // CardRow needs this since the whole row it lives in is itself a click
  // target — without it, opening/using the menu would also fire the row's
  // own onClick.
  stopClickPropagation?: boolean;
}

export function DropdownMenu({ trigger, children, stopClickPropagation = false }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  function handleTriggerClick(e: React.MouseEvent<HTMLElement>) {
    const opening = !open;
    setOpen(opening);
    if (opening) setDropUp(shouldDropUp(e.currentTarget));
  }

  // Locks whichever scroll container the menu actually lives in — usually a
  // local ScrollFade region (e.g. the deck list), not the page/document,
  // since those pages are already a bounded-height flex column with their
  // own internal scroller (see app/page.tsx). Falls back to html+body (the
  // same target useBodyScrollLock uses) only when no such local container
  // exists between here and <body>. Not reference-counted like
  // useBodyScrollLock — at most one DropdownMenu is ever open at a time,
  // since opening a second one always counts as an "outside" click that
  // closes whichever was already open first (see the effect below).
  useEffect(() => {
    if (!open || !wrapperRef.current) return;
    const container = nearestScrollContainer(wrapperRef.current) as HTMLElement | null;
    const targets: HTMLElement[] = container ? [container] : [document.documentElement, document.body];
    const prevOverflow = targets.map((t) => t.style.overflow);
    targets.forEach((t) => {
      t.style.overflow = 'hidden';
    });
    return () => {
      targets.forEach((t, i) => {
        t.style.overflow = prevOverflow[i];
      });
    };
  }, [open]);

  // Closes on any outside interaction, same as before — but via a document
  // listener instead of a `fixed inset-0` click-catcher div. That overlay
  // sat on top of the entire viewport while open, which (for a dropdown
  // opened near the bottom of a scrollable list, e.g. the list's last row)
  // silently ate the scroll/touch gesture needed to reveal the rest of the
  // menu instead of letting it reach the actual scrolling container
  // underneath. A menu opened on the trigger or on one of its own items is
  // never "outside" (both live inside wrapperRef), so this doesn't race
  // with either of those clicks.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: Event) => {
      if (wrapperRef.current && e.target instanceof Node && wrapperRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [open]);

  return (
    <div
      ref={wrapperRef}
      className="relative shrink-0"
      onClick={stopClickPropagation ? (e) => e.stopPropagation() : undefined}
    >
      {trigger({ onClick: handleTriggerClick, open })}

      {open && (
        <div
          className={`absolute right-0 z-50 flex gap-0.5 rounded-md border border-neutral-800 bg-neutral-950 p-0.5 shadow-lg ${
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
