'use client';

import { useState, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import Link from 'next/link';
import { ArrowLeft, Search } from 'lucide-react';
import { db, type Card } from '@/lib/db';
import { editCard, deleteCard, cloneCard } from '@/lib/actions';
import { useUser } from '@/lib/useUser';
import { CardRow } from '@/components/CardRow';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useLoadingWhen } from '@/components/GlobalLoading';
import { sortQueue } from '@/lib/fsrs';
import { useSmartBack } from '@/lib/useSmartBack';
import { sync } from '@/lib/sync';
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

  // Title gesture timers
  const REFRESH_HOLD_MS = 1_000;
  const pressStartRef = useRef<number | null>(null);

  function startPressHoldTimers() {
    pressStartRef.current = Date.now();
  }
  
  function cancelPressHoldTimers() {
    pressStartRef.current = null;
  }
  
  function endPressHoldTimers() {
    const start = pressStartRef.current;
    cancelPressHoldTimers();
    if (start === null) return;
    const heldMs = Date.now() - start;
    if (heldMs >= REFRESH_HOLD_MS) {
      window.location.reload();
    }
  }

  async function handleTitleClick() {
    if (!user) return;
    try {
      await sync(user.id);
    } catch (err) {
      console.error('Manual sync failed:', err);
    }
  }

  if (userLoading || !user) {
    return null;
  }

  return (
    <main className="mx-auto mb-4 max-w-md p-6 sm:mb-0">
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={goBack}
          aria-label="Back to review"
          className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
        >
          <ArrowLeft size={16} />
        </button>
        <h1
          className="cursor-pointer text-lg font-semibold select-none"
          onMouseDown={startPressHoldTimers}
          onMouseUp={endPressHoldTimers}
          onTouchStart={startPressHoldTimers}
          onTouchEnd={endPressHoldTimers}
          onTouchCancel={cancelPressHoldTimers}
          onClick={handleTitleClick}
          role="button"
          aria-label="Sync now"
          title="Sync now"
        >
          All cards
        </h1>
        <Link
          href={`/review/${params.deckId}/browse`}
          aria-label="Browse this deck"
          className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
        >
          <Search size={16} />
        </Link>
      </div>

      <p className="mb-2 text-xs text-neutral-500">{allCards?.length ?? 0} cards</p>

      <ul className="space-y-2">
        {allCards?.map((card) => (
          <CardRow
            key={card.id}
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
