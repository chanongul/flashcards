'use client';

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
  if (!open) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="pointer-events-auto max-h-[85vh] w-full max-w-sm overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="break-words text-sm font-medium">{title}</p>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="shrink-0 text-neutral-400 hover:text-neutral-200"
          >
            <X size={16} />
          </button>
        </div>
        <p className="mb-4 break-words text-sm text-neutral-400">{message}</p>
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
