'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

// Final CSS `fixed`-position values, not raw trigger coordinates — computed
// once in updateCoords rather than re-derived at render time, so which of
// `top`/`bottom` applies (drop-down vs. drop-up) never has to be re-decided
// or reconstructed anywhere else.
type Coords = { right: number } & ({ top: number; bottom?: undefined } | { bottom: number; top?: undefined });

export function DropdownMenu({ trigger, children, stopClickPropagation = false }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Recomputed on open and on every scroll/resize anywhere (see the effect
  // below) — the popover is portaled to <body> and positioned with
  // `position: fixed` in raw viewport coordinates precisely so it can never
  // be clipped by an ancestor's overflow (see the doc comment on `open &&`
  // below for why that's not just theoretical here). `position: fixed`
  // means it has to track the trigger's own live position itself, unlike
  // the old `position: absolute` version, which got that for free by
  // living inside the same positioned ancestor as the trigger.
  function updateCoords() {
    const trigger = wrapperRef.current?.firstElementChild as HTMLElement | null;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const right = window.innerWidth - rect.right;
    setCoords(
      shouldDropUp(trigger)
        ? { right, bottom: window.innerHeight - rect.top + 4 }
        : { right, top: rect.bottom + 4 }
    );
  }

  function handleTriggerClick(e: React.MouseEvent<HTMLElement>) {
    const opening = !open;
    if (opening) updateCoords();
    setOpen(opening);
  }

  // Keeps the popover correctly anchored to the trigger for as long as it's
  // open — e.g. TiptapFieldInput's own horizontally-scrolling toolbar can
  // move its trigger buttons out from under a position computed once at
  // open-time; the scroll-lock effect below only freezes the trigger's
  // *nearest actually-vertically-scrollable* ancestor, not a purely
  // horizontal one like that toolbar row. Listened on `document` with
  // `capture: true` (not `window`) so it catches a scroll happening on ANY
  // scrollable descendant, not just the window itself — scroll events
  // don't bubble, but they do fire during the capture phase on every
  // ancestor of whatever actually scrolled.
  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => updateCoords();
    document.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
  // never "outside" (both live inside wrapperRef, or — the popover itself —
  // popoverRef; the popover is portaled to <body> now, so DOM-wise it's no
  // longer a descendant of wrapperRef and needs its own check), so this
  // doesn't race with either of those clicks.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: Event) => {
      if (e.target instanceof Node) {
        if (wrapperRef.current?.contains(e.target)) return;
        if (popoverRef.current?.contains(e.target)) return;
      }
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

      {/* Portaled to <body>, not rendered inline where the old `position:
          absolute` version lived — an inline popover is clipped by *any*
          ancestor with non-visible overflow on either axis, which isn't
          just a hypothetical: TiptapFieldInput's toolbar needs overflow-x:
          auto for its own horizontal scroll, and per the CSS overflow spec
          that forces its computed overflow-y to 'auto' too (leaving one
          axis 'visible' while the other is set to anything else makes the
          'visible' one compute as 'auto' instead) — genuinely, not just
          nominally, clipping vertically. Confirmed empirically: the color
          swatch grid (two rows) got silently clipped there while the
          shorter one-row align menu happened to still fit, which is what
          exposed this. `position: fixed` + coords computed in real
          viewport pixels (see updateCoords) sidesteps clipping entirely,
          regardless of which ancestor caused it or why — this isn't
          specific to that one toolbar. */}
      {open &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-50 flex gap-0.5 rounded-md border border-neutral-800 bg-neutral-950 p-0.5 shadow-lg"
            style={coords}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body
        )}
    </div>
  );
}
