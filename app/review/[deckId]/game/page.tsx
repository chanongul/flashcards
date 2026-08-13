'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Dices } from 'lucide-react';
import { db, type Card } from '@/lib/db';
import { useUser } from '@/lib/useUser';
import { useSmartBack } from '@/lib/useSmartBack';
import { useTitleSync } from '@/lib/useTitleSync';
import { useLoadingWhen } from '@/components/GlobalLoading';
import { CardFaces } from '@/components/CardFaces';
import { ClozeRevealPart } from '@/components/ClozeRevealPart';
import { ScrollFade } from '@/components/ScrollFade';
import { cardFrontHtml, cardBackHtml } from '@/lib/cardContent';
import { deckBreadcrumb, getDeckAndDescendantIds } from '@/lib/decks';

/** Casual, no-pressure browsing mode: a random card from the deck (any
 * FSRS state, not just what's due) with just a reveal — no grading, no
 * scheduling effects, no jot sheet. Suspended cards are still excluded,
 * same as everywhere else in the app suspended means "don't show me this". */
export default function GameModePage() {
  const params = useParams<{ deckId: string }>();
  const goBack = useSmartBack(`/review/${params.deckId}`);
  const { user, loading: userLoading } = useUser();
  useLoadingWhen(userLoading || !user);

  const deck = useLiveQuery(() => db.decks.get(params.deckId), [params.deckId]);

  const pool = useLiveQuery(
    async () => {
      const deckIds = await getDeckAndDescendantIds(params.deckId);
      return db.cards
        .where('deckId')
        .anyOf(deckIds)
        .filter((c) => !c.deleted && !c.suspended)
        .toArray();
    },
    [params.deckId]
  );

  const [current, setCurrent] = useState<Card | null>(null);
  const [revealed, setRevealed] = useState(false);
  // Sticky mode: while on, every card (including the one picked next) stays
  // revealed automatically — "Show once"/"Hide once" still work on top of it
  // as a temporary override for just the current card, but the next
  // randomize snaps back to whatever alwaysShow says.
  const [alwaysShow, setAlwaysShow] = useState(false);

  // Picks once pool first loads; never auto-repicks on later pool changes
  // (an edit elsewhere while playing shouldn't yank the current card away).
  useEffect(() => {
    if (pool && !current) pickRandom(pool);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool]);

  function pickRandom(cards: Card[]) {
    if (cards.length === 0) {
      setCurrent(null);
      return;
    }
    const choices = current && cards.length > 1 ? cards.filter((c) => c.id !== current.id) : cards;
    setCurrent(choices[Math.floor(Math.random() * choices.length)]);
    setRevealed(alwaysShow);
  }

  function toggleAlwaysShow() {
    setAlwaysShow((v) => {
      const next = !v;
      setRevealed(next);
      return next;
    });
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
    <main className="mx-auto flex h-[calc(100dvh-1rem)] max-w-md flex-col p-6 pt-2 md:pt-6 md:h-dvh">
      <div className="mb-4 flex shrink-0 items-center justify-between gap-2">
        <button
          onClick={goBack}
          aria-label="Back to review"
          className="rounded-md py-1.5 text-neutral-400 hover:text-neutral-200"
        >
          <ArrowLeft size={20} />
        </button>

        {deck && (
          <p
            className={`min-w-0 truncate text-center text-sm text-neutral-500 ${isOnline ? 'cursor-pointer' : 'cursor-not-allowed opacity-80'}`}
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
            {deckBreadcrumb(deck.name)}
          </p>
        )}

        <button
          onClick={() => pool && pickRandom(pool)}
          aria-label="Random card"
          className="text-neutral-400 hover:text-orange-600 active:text-orange-600"
        >
          <Dices size={20} />
        </button>
      </div>

      {syncError && <p className="mb-2 shrink-0 text-xs text-red-400">{syncError}</p>}

      {current ? (
        <div className="flex flex-1 flex-col gap-4">
          <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 px-4 text-center">
            {current.cardType === 'cloze' ? (
              <>
                <ScrollFade>
                  <div className="flex min-h-full flex-col items-center justify-center py-4">
                    <ClozeRevealPart
                      text={current.front}
                      activeIndex={current.clozeIndex ?? 1}
                      mode="user"
                      userValues={[]}
                    />
                  </div>
                </ScrollFade>
                {revealed && (
                  <>
                    <hr className="shrink-0 border-neutral-800" />
                    <ScrollFade>
                      <div className="flex min-h-full flex-col items-center justify-center py-4">
                        <ClozeRevealPart
                          text={current.front}
                          activeIndex={current.clozeIndex ?? 1}
                          mode="answer"
                          userValues={[]}
                        />
                      </div>
                    </ScrollFade>
                  </>
                )}
              </>
            ) : (
              <CardFaces front={cardFrontHtml(current)} back={cardBackHtml(current)} showBack={revealed} />
            )}
          </div>

          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => setRevealed((v) => !v)}
              className="flex-1 rounded-full border border-transparent bg-neutral-100 py-3 text-sm font-medium text-neutral-900"
            >
              {revealed ? 'Hide once' : 'Show once'}
            </button>
            <button
              onClick={toggleAlwaysShow}
              aria-pressed={alwaysShow}
              className={`flex-1 rounded-full border py-3 text-sm font-medium ${
                alwaysShow
                  ? 'border-orange-600 bg-orange-600 text-neutral-100'
                  : 'border-neutral-700 text-neutral-300'
              }`}
            >
              {alwaysShow ? 'Always hide' : 'Always show'}
            </button>
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-neutral-800 p-8 text-center text-sm text-neutral-400">
          No cards in this deck yet.
        </p>
      )}
    </main>
  );
}
