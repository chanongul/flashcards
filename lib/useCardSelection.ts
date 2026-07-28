import { useState } from 'react';
import type { Card } from './db';
import { editCard, cloneCard, deleteCard } from './actions';

/** Shared selection state + bulk-action logic for a card list page (see
 * app/browse, app/review/[deckId]/all, app/review/[deckId]/browse) — every
 * per-row action CardRow's dropdown offers except info/edit (which only
 * ever make sense for one card), generalized to a whole selection.
 *
 * Bulk operations run sequentially, not Promise.all: each of editCard/
 * cloneCard/deleteCard does its own full logEvent -> replayAllEvents ->
 * pushEvents round trip, and replayAllEvents rebuilds the decks/cards/notes
 * tables from the *entire* event log in one transaction — firing several
 * concurrently risked overlapping reads/rebuilds racing each other. One at
 * a time is slower for a big selection but never racy. */
export function useCardSelection(cards: Card[], userId: string | undefined) {
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  function toggleSelectMode() {
    setSelectMode((v) => !v);
    setSelectedIds(new Set());
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  function toggleSelect(card: Card) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(card.id)) next.delete(card.id);
      else next.add(card.id);
      return next;
    });
  }

  const selectedCards = cards.filter((c) => selectedIds.has(c.id));
  const allSelected = cards.length > 0 && selectedCards.length === cards.length;

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(cards.map((c) => c.id)));
  }

  // Same "acts as one group" convention CardRow's own Star/Ban buttons
  // already use per-row: only reads as "on" when every selected card
  // already has it, so the button's next click is always a clean set-all-
  // to-the-same-state rather than an inconsistent per-card toggle.
  const flagLabel: 'Flag' | 'Unflag' =
    selectedCards.length > 0 && selectedCards.every((c) => c.flagged) ? 'Unflag' : 'Flag';
  const suspendLabel: 'Suspend' | 'Unsuspend' =
    selectedCards.length > 0 && selectedCards.every((c) => c.suspended) ? 'Unsuspend' : 'Suspend';

  function uniqueNoteIds(): string[] {
    return Array.from(new Set(selectedCards.map((c) => c.noteId)));
  }

  // One representative card id per unique note — cloneCard already resolves
  // the whole sibling group from whichever card id it's given, so cloning
  // every selected sibling of the same note would otherwise duplicate that
  // note once per selected sibling instead of once total.
  function representativeCardIds(): string[] {
    const seen = new Set<string>();
    const reps: string[] = [];
    for (const c of selectedCards) {
      if (!seen.has(c.noteId)) {
        seen.add(c.noteId);
        reps.push(c.id);
      }
    }
    return reps;
  }

  async function bulkFlag() {
    if (!userId) return;
    const next = flagLabel === 'Flag';
    for (const c of selectedCards) await editCard(userId, c.id, { flagged: next });
  }

  async function bulkSuspend() {
    if (!userId) return;
    const next = suspendLabel === 'Suspend';
    for (const c of selectedCards) await editCard(userId, c.id, { suspended: next });
  }

  async function bulkMove(deckId: string) {
    if (!userId) return;
    for (const noteId of uniqueNoteIds()) await editCard(userId, noteId, { deckId });
    exitSelectMode();
  }

  async function bulkDuplicate(deckId: string) {
    if (!userId) return;
    for (const cardId of representativeCardIds()) await cloneCard(userId, cardId, deckId);
    exitSelectMode();
  }

  async function bulkDelete() {
    if (!userId) return;
    for (const noteId of uniqueNoteIds()) await deleteCard(userId, noteId);
    exitSelectMode();
  }

  return {
    selectMode,
    toggleSelectMode,
    exitSelectMode,
    selectedIds,
    toggleSelect,
    selectedCards,
    allSelected,
    toggleSelectAll,
    flagLabel,
    suspendLabel,
    bulkFlag,
    bulkSuspend,
    bulkMove,
    bulkDuplicate,
    bulkDelete,
  };
}
