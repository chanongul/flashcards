'use client';

import { X } from 'lucide-react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';

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
  useBodyScrollLock(open);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-4"
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
