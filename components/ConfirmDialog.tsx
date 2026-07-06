'use client';

import { useRef } from 'react';
import { X } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const touchStartY = useRef<number | null>(null);

  if (!open) return null;

  // Unlike the bigger modals, this dialog doesn't lock body scroll — but a
  // fixed full-viewport backdrop still sits on top of the page and normally
  // eats touch-drags before they can reach it, so scrolling wouldn't work
  // either way without this: forward drags on the backdrop into a real
  // page scroll by hand.
  function handleTouchStart(e: React.TouchEvent) {
    touchStartY.current = e.touches[0]?.clientY ?? null;
  }
  function handleTouchMove(e: React.TouchEvent) {
    if (touchStartY.current === null) return;
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    window.scrollBy(0, touchStartY.current - y);
    touchStartY.current = y;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
    >
      <div
        className="max-h-[85vh] w-full max-w-sm overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-medium">{title}</p>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="text-neutral-400 hover:text-neutral-200"
          >
            <X size={16} />
          </button>
        </div>
        <p className="mb-4 text-sm text-neutral-400">{message}</p>
        <div className="flex gap-2">
          <button
            onClick={onConfirm}
            className="flex-1 rounded-md bg-red-900/50 py-2 text-sm font-medium text-red-200"
          >
            {confirmLabel}
          </button>
          <button
            onClick={onCancel}
            className="flex-1 rounded-md border border-neutral-700 py-2 text-sm text-neutral-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
