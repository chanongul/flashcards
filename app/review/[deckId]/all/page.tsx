'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import Link from 'next/link';
import { ArrowLeft, FolderSearch, Plus } from 'lucide-react';
import { db, type Card } from '@/lib/db';
import { editCard, deleteCard, cloneCard, createCard } from '@/lib/actions';
import { useUser } from '@/lib/useUser';
import { CardRow } from '@/components/CardRow';
import { CardForm } from '@/components/CardForm';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Modal } from '@/components/base/Modal';
import { useLoadingWhen } from '@/components/GlobalLoading';
import { sortQueue } from '@/lib/fsrs';
import { useSmartBack } from '@/lib/useSmartBack';
import { useTitleSync } from '@/lib/useTitleSync';
import { getDeckAndDescendantIds } from '@/lib/decks';

export default function AllCardsPage() {
  const params = useParams<{ deckId: string }>();
  const goBack = useSmartBack(`/review/${params.deckId}`);
  const { user, loading: userLoading } = useUser();
  useLoadingWhen(userLoading || !user);

  const allCards = useLiveQuery(
    async () => {
      const deckIds = await getDeckAndDescendantIds(params.deckId);
      return db.cards
        .where('deckId')
        .anyOf(deckIds)
        .filter((c) => !c.deleted)
        .toArray()
        .then(sortQueue);
    },
    [params.deckId]
  );

  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const [showAddModal, setShowAddModal] = useState(false);
  // Set to the just-created note's id on submit; once that note's card shows
  // up in the (reactive) allCards list, we scroll it into view and briefly
  // highlight it — the "New" cards a plain creation-order sort would put it
  // at the bottom of an already-long list otherwise makes it easy to lose.
  const [pendingScrollNoteId, setPendingScrollNoteId] = useState<string | null>(null);
  const [highlightCardId, setHighlightCardId] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingScrollNoteId || !allCards) return;
    const match = allCards.find((c) => c.noteId === pendingScrollNoteId);
    if (!match) return;
    setPendingScrollNoteId(null);
    setHighlightCardId(match.id);
    document.getElementById(`card-${match.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [allCards, pendingScrollNoteId]);

  // Separate from the effect above on purpose: allCards is a useLiveQuery
  // result, which gets a new array reference on every reactive update, not
  // just the one that satisfies pendingScrollNoteId — a background sync
  // pulling in unrelated changes mid-highlight would re-run that effect,
  // whose cleanup would cancel this timer without anything left to
  // reschedule it (pendingScrollNoteId is already null by then), leaving
  // the highlight stuck on permanently. Keying this timer only on
  // highlightCardId itself means unrelated allCards churn can't touch it.
  useEffect(() => {
    if (!highlightCardId) return;
    const timeout = setTimeout(() => setHighlightCardId(null), 2000);
    return () => clearTimeout(timeout);
  }, [highlightCardId]);

  async function handleSaveEdit(
    cardId: string,
    changes: Partial<{
      front: string;
      back: string;
      fields: Record<string, string>;
      tags: string[];
      reversed: boolean;
    }>
  ) {
    if (!user) return;
    await editCard(user.id, cardId, changes);
  }

  function handleDelete(cardId: string) {
    setConfirmState({
      title: 'Delete card',
      message: 'Delete this card? This cannot be undone.',
      onConfirm: async () => {
        if (!user) return;
        await deleteCard(user.id, cardId);
        setConfirmState(null);
      },
    });
  }

  async function handleToggleFlag(card: Card) {
    if (!user) return;
    await editCard(user.id, card.id, { flagged: !card.flagged });
  }

  async function handleToggleSuspend(card: Card) {
    if (!user) return;
    await editCard(user.id, card.id, { suspended: !card.suspended });
  }

  async function handleClone(cardId: string, deckId: string) {
    if (!user) return;
    await cloneCard(user.id, cardId, deckId);
  }

  const {
    isOnline,
    syncError,
    startPressHoldTimers,
    cancelPressHoldTimers,
    endPressHoldTimers,
    handleTitleClick,
  } = useTitleSync({ userId: user?.id });

  if (userLoading || !user) {
    return null;
  }

  return (
    <main className="mx-auto mb-4 max-w-md p-6 pt-2 md:pt-6 sm:mb-0">
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={goBack}
          aria-label="Back to review"
          className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
        >
          <ArrowLeft size={16} />
        </button>
        <h1
          className={`text-lg font-semibold ${isOnline ? 'cursor-pointer' : 'cursor-not-allowed opacity-80'}`}
          onMouseDown={startPressHoldTimers}
          onMouseUp={endPressHoldTimers}
          onTouchStart={startPressHoldTimers}
          onTouchEnd={endPressHoldTimers}
          onTouchCancel={cancelPressHoldTimers}
          onClick={handleTitleClick}
          role="button"
          aria-label={isOnline ? 'Sync now' : 'Offline — sync unavailable'}
          title={isOnline ? 'Sync now' : 'Offline — sync unavailable'}
        >
          All cards
        </h1>
        <Link
          href={`/review/${params.deckId}/browse`}
          aria-label="Browse this deck"
          className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
        >
          <FolderSearch size={16} />
        </Link>
      </div>

      {syncError && <p className="mb-2 text-xs text-red-400">{syncError}</p>}

      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-neutral-500">{allCards?.length ?? 0} cards</p>
        <button
          onClick={() => setShowAddModal(true)}
          aria-label="Add a card"
          className="text-neutral-500 hover:text-neutral-200"
        >
          <Plus size={16} />
        </button>
      </div>

      <ul className="space-y-2">
        {allCards?.map((card) => (
          <CardRow
            key={card.id}
            id={`card-${card.id}`}
            highlighted={highlightCardId === card.id}
            card={card}
            onSave={handleSaveEdit}
            onDelete={handleDelete}
            onToggleFlag={handleToggleFlag}
            onToggleSuspend={handleToggleSuspend}
            onClone={handleClone}
          />
        ))}
        {allCards && allCards.length === 0 && (
          <p className="text-sm text-neutral-500">No cards yet.</p>
        )}
      </ul>

      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="New card">
        <CardForm
          mode="create"
          onSubmit={async (data) => {
            if (!user) return;
            const noteId = await createCard(
              user.id,
              params.deckId,
              data.cardType,
              data.front,
              data.back,
              data.tags,
              data.fields,
              data.reversed
            );
            setShowAddModal(false);
            setPendingScrollNoteId(noteId);
          }}
          onCancel={() => setShowAddModal(false)}
        />
      </Modal>

      <ConfirmDialog
        open={!!confirmState}
        title={confirmState?.title ?? ''}
        message={confirmState?.message ?? ''}
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />
    </main>
  );
}
