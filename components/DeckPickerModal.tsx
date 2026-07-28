'use client';

import { Modal } from './base/Modal';
import { DeckSelect } from './DeckSelect';
import type { DeckTreeRow } from '@/lib/decks';

interface DeckPickerModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  confirmLabel: string;
  rows: DeckTreeRow[];
  value: string;
  onChange: (deckId: string) => void;
  onConfirm: () => void;
}

// Modal + DeckSelect + confirm/cancel, shared by every "pick a deck, then
// act" flow (single-card clone/move in CardRow, bulk move/duplicate) —
// previously duplicated per call site.
export function DeckPickerModal({
  open,
  onClose,
  title,
  confirmLabel,
  rows,
  value,
  onChange,
  onConfirm,
}: DeckPickerModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="fit">
      <DeckSelect rows={rows} value={value} onChange={onChange} label="Deck" />
      <div className="mt-3 flex gap-2">
        <button
          onClick={onConfirm}
          className="flex-1 rounded-md bg-neutral-100 py-2 text-sm font-medium text-neutral-900"
        >
          {confirmLabel}
        </button>
        <button
          onClick={onClose}
          className="flex-1 rounded-md border border-neutral-700 py-2 text-sm text-neutral-300"
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}
