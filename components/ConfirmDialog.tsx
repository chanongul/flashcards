'use client';

import { Modal } from './base/Modal';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  // 'destructive' (default) matches every existing delete-confirmation
  // call site; 'neutral' is for a non-destructive confirm (e.g. JotPad's
  // "this will clear your drawing" resize confirmation).
  confirmVariant?: 'destructive' | 'neutral';
  // Off by default — deliberate for a destructive confirm: an accidental
  // backdrop tap shouldn't be able to dismiss it as a side effect of
  // reaching for something else on screen.
  closeOnBackdropClick?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  confirmVariant = 'destructive',
  closeOnBackdropClick = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={<span className="break-words">{title}</span>}
      size="fit"
      closeOnBackdropClick={closeOnBackdropClick}
    >
      <p className="mb-4 break-words text-sm text-neutral-400">{message}</p>
      <div className="flex gap-2">
        <button
          onClick={onConfirm}
          className={`flex-1 rounded-md py-2 text-sm font-medium ${
            confirmVariant === 'destructive'
              ? 'bg-red-900/50 text-red-200'
              : 'bg-neutral-100 text-neutral-900'
          }`}
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
    </Modal>
  );
}
