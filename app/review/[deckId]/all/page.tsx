'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft } from 'lucide-react';
import { db, type Card } from '@/lib/db';
import { editCard, deleteCard } from '@/lib/actions';
import { useUser } from '@/lib/useUser';
import { CardRow } from '@/components/CardRow';
import { ConfirmDialog } from '@/components/ConfirmDialog';

export default function AllCardsPage() {
  const params = useParams<{ deckId: string }>();
  const router = useRouter();
  const { user, loading: userLoading } = useUser();

  const allCards = useLiveQuery(
    () => db.cards.where('deckId').equals(params.deckId).filter((c) => !c.deleted).toArray(),
    [params.deckId]
  );

  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  async function handleSaveEdit(
    cardId: string,
    changes: Partial<{ front: string; back: string; fields: Record<string, string>; tags: string[] }>
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

  if (userLoading || !user) {
    return (
      <main className="mx-auto mb-4 max-w-md p-6 sm:mb-0">
        <p className="text-sm text-neutral-500">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto mb-4 max-w-md p-6 sm:mb-0">
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={() => router.push(`/review/${params.deckId}`)}
          aria-label="Back to review"
          className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold">All cards</h1>
        <div className="w-9" />
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
