'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Search } from 'lucide-react';
import { db, type Card } from '@/lib/db';
import { editCard, deleteCard } from '@/lib/actions';
import { useUser } from '@/lib/useUser';
import { CardRow } from '@/components/CardRow';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { clozeQuestion } from '@/lib/cloze';
import { stripHtml } from '@/lib/sanitize';
import { getDeckAndDescendantIds, deckDisplayName } from '@/lib/decks';

export default function DeckSearchPage() {
  const params = useParams<{ deckId: string }>();
  const router = useRouter();
  const { user, loading: userLoading } = useUser();
  const [query, setQuery] = useState('');
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const deckNameById = new Map((decks ?? []).map((d) => [d.id, d.name]));

  // Scope: this deck plus every subdeck (matches what reviewing the deck
  // covers), rather than browse's whole-collection search.
  const deckCards = useLiveQuery(async () => {
    const deckIds = await getDeckAndDescendantIds(params.deckId);
    return db.cards.where('deckId').anyOf(deckIds).filter((c) => !c.deleted).toArray();
  }, [params.deckId]);

  // Same matching algorithm as the global browse page.
  const filtered = (deckCards ?? []).filter((card) => {
    if (!query.trim()) return false;
    const q = query.trim().toLowerCase();
    const text =
      card.cardType === 'cloze'
        ? clozeQuestion(card.front)
        : `${stripHtml(card.front)} ${stripHtml(card.back)}`;
    const deckName = deckNameById.get(card.deckId) ?? '';
    const tags = card.tags.join(' ');
    return (
      text.toLowerCase().includes(q) ||
      deckName.toLowerCase().includes(q) ||
      tags.toLowerCase().includes(q)
    );
  });

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
        <h1 className="text-lg font-semibold">Search deck</h1>
        <div className="w-9" />
      </div>

      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this deck's cards…"
          autoFocus
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 py-2 pl-9 pr-3 text-sm"
        />
      </div>

      {query.trim() && (
        <p className="mb-2 text-xs text-neutral-500">
          {filtered.length} card{filtered.length === 1 ? '' : 's'}
        </p>
      )}

      <ul className="space-y-2">
        {filtered.map((card) => (
          <CardRow
            key={card.id}
            card={card}
            deckName={
              card.deckId !== params.deckId
                ? deckDisplayName(deckNameById.get(card.deckId) ?? '')
                : undefined
            }
            onSave={handleSaveEdit}
            onDelete={handleDelete}
            onToggleFlag={handleToggleFlag}
            onToggleSuspend={handleToggleSuspend}
          />
        ))}
        {query.trim() ? (
          filtered.length === 0 && <p className="text-sm text-neutral-500">No cards match.</p>
        ) : (
          <p className="text-sm text-neutral-500">Type to search this deck's cards.</p>
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
