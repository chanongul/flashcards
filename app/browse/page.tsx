'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Search, Star } from 'lucide-react';
import { db } from '@/lib/db';
import { editCard, deleteCard, cloneCard } from '@/lib/actions';
import { useUser } from '@/lib/useUser';
import { CardRow } from '@/components/CardRow';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { cardSearchText } from '@/lib/search';
import { useLoadingWhen } from '@/components/GlobalLoading';

export default function BrowsePage() {
  const router = useRouter();
  const { user, loading: userLoading } = useUser();
  useLoadingWhen(userLoading || !user);
  const [query, setQuery] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray(), []);
  const allCards = useLiveQuery(() => db.cards.filter((c) => !c.deleted).toArray(), []);

  const deckNameById = new Map((decks ?? []).map((d) => [d.id, d.name]));

  const filtered = (allCards ?? []).filter((card) => {
    if (favoritesOnly && !card.flagged) return false;
    const q = query.trim().toLowerCase();
    // With the favorites filter on, an empty query still shows every
    // favorite — only plain search requires you to actually type something.
    if (!q) return favoritesOnly;
    const text = cardSearchText(card);
    const deckName = deckNameById.get(card.deckId) ?? '';
    const tags = card.tags.join(' ');
    return (
      text.toLowerCase().includes(q) ||
      deckName.toLowerCase().includes(q) ||
      tags.toLowerCase().includes(q)
    );
  });
  const hasActiveFilter = query.trim() !== '' || favoritesOnly;

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

  async function handleToggleFlag(card: (typeof filtered)[number]) {
    if (!user) return;
    await editCard(user.id, card.id, { flagged: !card.flagged });
  }

  async function handleToggleSuspend(card: (typeof filtered)[number]) {
    if (!user) return;
    await editCard(user.id, card.id, { suspended: !card.suspended });
  }

  async function handleClone(cardId: string, deckId: string) {
    if (!user) return;
    await cloneCard(user.id, cardId, deckId);
  }

  if (userLoading || !user) {
    return null;
  }

  return (
    <main className="mx-auto mb-4 max-w-md p-6 sm:mb-0">
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={() => router.push('/')}
          aria-label="Back to decks"
          className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold">Browse</h1>
        <button
          onClick={() => setFavoritesOnly((v) => !v)}
          aria-label={favoritesOnly ? 'Show all cards' : 'Show favorites only'}
          aria-pressed={favoritesOnly}
          className={`text-yellow-400 ${favoritesOnly ? '' : 'opacity-40 hover:opacity-70'}`}
        >
          <Star size={20} fill="currentColor" />
        </button>
      </div>

      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search cards, tags, or deck names…"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 py-2 pl-9 pr-3 text-sm"
        />
      </div>

      {hasActiveFilter && (
        <p className="mb-2 text-xs text-neutral-500">
          {filtered.length} card{filtered.length === 1 ? '' : 's'}
        </p>
      )}

      <ul className="space-y-2">
        {filtered.map((card) => (
          <CardRow
            key={card.id}
            card={card}
            deckName={deckNameById.get(card.deckId)}
            onSave={handleSaveEdit}
            onDelete={handleDelete}
            onToggleFlag={handleToggleFlag}
            onToggleSuspend={handleToggleSuspend}
            onClone={handleClone}
          />
        ))}
        {hasActiveFilter ? (
          filtered.length === 0 && <p className="text-sm text-neutral-500">No cards match.</p>
        ) : (
          <p className="text-sm text-neutral-500">Type to search your cards.</p>
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
