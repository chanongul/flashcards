'use client';

import { useState } from 'react';
import { shouldDropUp } from '@/lib/dropdownMenu';

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

  function handleTriggerClick(e: React.MouseEvent<HTMLElement>) {
    const opening = !open;
    setOpen(opening);
    if (opening) setDropUp(shouldDropUp(e.currentTarget.getBoundingClientRect()));
  }

  return (
    <div
      className="relative shrink-0"
      onClick={stopClickPropagation ? (e) => e.stopPropagation() : undefined}
    >
      {trigger({ onClick: handleTriggerClick, open })}

      {open && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            className={`absolute right-0 z-50 flex gap-0.5 rounded-md border border-neutral-800 bg-neutral-950 p-0.5 shadow-lg ${
              dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
            }`}
          >
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  );
}
