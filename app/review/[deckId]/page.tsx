'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Plus, X, Undo2, List, Settings, CalendarClock, Search } from 'lucide-react';
import {
  getDueCards,
  getDueCardsAhead,
  reviewCard,
  undoReview,
  createCard,
  editDeck,
} from '@/lib/actions';
import { Rating, type Grade } from '@/lib/fsrs';
import { db, type Card } from '@/lib/db';
import { useUser } from '@/lib/useUser';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { clozeQuestionFor, clozeAnswerFor, hasClozeDeletion } from '@/lib/cloze';
import { RichTextInput } from '@/components/RichTextInput';
import { RichText } from '@/components/RichText';
import { Checkbox } from '@/components/Checkbox';
import { TagsInput } from '@/components/TagsInput';
import { ScrollFade } from '@/components/ScrollFade';
import { stripHtml } from '@/lib/sanitize';
import { countCardsByState, DECK_COUNT_TOOLTIPS } from '@/lib/stats';
import { deckBreadcrumb, deckDisplayName, deckParentName, getDeckAndDescendantIds } from '@/lib/decks';

function questionText(card: Card): string {
  if (card.cardType === 'cloze') return clozeQuestionFor(card.front, card.clozeIndex ?? 1);
  if (card.isReversed) return card.back;
  return card.front;
}

function answerText(card: Card): string {
  if (card.cardType === 'cloze') return clozeAnswerFor(card.front, card.clozeIndex ?? 1);
  if (card.isReversed) return card.front;
  return card.back;
}

export default function ReviewPage() {
  const params = useParams<{ deckId: string }>();
  const router = useRouter();
  const { user, loading: userLoading } = useUser();
  const [queue, setQueue] = useState<Card[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);

  // 'basic' | 'cloze', or a NoteType id for a custom type
  const [newCardType, setNewCardType] = useState<string>('basic');
  const [newFront, setNewFront] = useState('');
  const [newBack, setNewBack] = useState('');
  const [newReversed, setNewReversed] = useState(false);
  const [newClozeText, setNewClozeText] = useState('');
  const [newFields, setNewFields] = useState<Record<string, string>>({});
  const [newTags, setNewTags] = useState<string[]>([]);
  const [addCardError, setAddCardError] = useState('');

  const noteTypes = useLiveQuery(() => db.noteTypes.filter((nt) => !nt.deleted).toArray(), []);
  const selectedNoteType = noteTypes?.find((nt) => nt.id === newCardType);

  const [showAddModal, setShowAddModal] = useState(false);
  const [showDeckOptions, setShowDeckOptions] = useState(false);
  const [showCustomStudy, setShowCustomStudy] = useState(false);

  useBodyScrollLock(showAddModal || showDeckOptions || showCustomStudy);

  const [deckNameInput, setDeckNameInput] = useState('');
  const [newCardsPerDay, setNewCardsPerDay] = useState(0);
  const [reviewsPerDay, setReviewsPerDay] = useState(0);
  const [studyAheadDays, setStudyAheadDays] = useState(1);
  const [deckOptionsError, setDeckOptionsError] = useState('');
  const [customStudyError, setCustomStudyError] = useState('');

  const [lastReview, setLastReview] = useState<{ card: Card; reviewEventId: string } | null>(
    null
  );

  const deck = useLiveQuery(() => db.decks.get(params.deckId), [params.deckId]);

  const deckCounts = useLiveQuery(async () => {
    const deckIds = await getDeckAndDescendantIds(params.deckId);
    const cards = await db.cards
      .where('deckId')
      .anyOf(deckIds)
      .filter((c) => !c.deleted && !c.suspended)
      .toArray();
    return countCardsByState(cards);
  }, [params.deckId]);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    const due = await getDueCards(params.deckId);
    setQueue(due);
    setRevealed(false);
    setLoading(false);
  }, [params.deckId]);

  useEffect(() => {
    if (!user) return;
    loadQueue();
  }, [user, loadQueue]);

  const current = queue[0];

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (showAddModal || !current) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (!revealed) setRevealed(true);
        return;
      }

      if (!revealed) return;
      if (e.key === '1') handleRate(Rating.Again);
      else if (e.key === '2') handleRate(Rating.Hard);
      else if (e.key === '3') handleRate(Rating.Good);
      else if (e.key === '4') handleRate(Rating.Easy);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [current, revealed, showAddModal]);

  async function handleRate(rating: Grade) {
    if (!current || !user) return;
    const reviewEventId = await reviewCard(user.id, current.id, rating);
    setLastReview({ card: current, reviewEventId });
    setQueue((q) => q.slice(1));
    setRevealed(false);
  }

  async function handleUndo() {
    if (!lastReview || !user) return;
    await undoReview(user.id, lastReview.card.id, lastReview.reviewEventId);
    setLastReview(null);
    loadQueue();
  }

  function selectCardType(type: string) {
    // Clear everything on type switch so values from one type never leak
    // into another (e.g. basic front/back silently riding along after
    // switching to a custom type).
    setNewCardType(type);
    setNewFront('');
    setNewBack('');
    setNewReversed(false);
    setNewClozeText('');
    setNewFields({});
    setNewTags([]);
    setAddCardError('');
  }

  function closeAddModal() {
    setShowAddModal(false);
    selectCardType('basic');
  }

  async function handleAddCard(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;

    const tags = newTags;

    if (selectedNoteType) {
      if (selectedNoteType.fields.every((f) => !stripHtml(newFields[f] ?? '').trim())) {
        setAddCardError('Fill in at least one field.');
        return;
      }
      await createCard(
        user.id,
        params.deckId,
        selectedNoteType.id,
        '',
        '',
        tags,
        newFields,
        newReversed
      );
    } else if (newCardType === 'cloze') {
      if (!newClozeText.trim()) {
        setAddCardError('Enter the cloze text.');
        return;
      }
      if (!hasClozeDeletion(newClozeText)) {
        setAddCardError('Wrap at least one hidden word in {{c1::...}}.');
        return;
      }
      await createCard(user.id, params.deckId, 'cloze', newClozeText.trim(), '', tags);
    } else {
      if (!stripHtml(newFront).trim() || !stripHtml(newBack).trim()) {
        setAddCardError('Fill in both front and back.');
        return;
      }
      await createCard(user.id, params.deckId, newCardType, newFront, newBack, tags, undefined, newReversed);
    }
    closeAddModal();
    loadQueue();
  }

  function openDeckOptions() {
    if (!deck) return;
    setDeckNameInput(deckDisplayName(deck.name));
    setNewCardsPerDay(deck.newCardsPerDay);
    setReviewsPerDay(deck.reviewsPerDay);
    setDeckOptionsError('');
    setShowDeckOptions(true);
  }

  async function handleSaveDeckOptions(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !deck) return;
    const name = deckNameInput.trim();
    if (!name) {
      setDeckOptionsError('Enter a deck name.');
      return;
    }
    if (newCardsPerDay < 0 || reviewsPerDay < 0) {
      setDeckOptionsError('New cards/day and reviews/day cannot be negative.');
      return;
    }
    const parent = deckParentName(deck.name);
    const fullName = parent ? `${parent}::${name}` : name;
    await editDeck(user.id, params.deckId, {
      name: fullName,
      newCardsPerDay,
      reviewsPerDay,
    });
    setShowDeckOptions(false);
    loadQueue();
  }

  async function handleStartCustomStudy() {
    if (studyAheadDays < 0) {
      setCustomStudyError('Days ahead cannot be negative.');
      return;
    }
    const ahead = await getDueCardsAhead(params.deckId, studyAheadDays);
    setQueue(ahead);
    setRevealed(false);
    setShowCustomStudy(false);
  }

  if (userLoading || !user) {
    return (
      <main className="mx-auto mb-4 max-w-md p-6 sm:mb-0">
        <p className="text-sm text-neutral-500">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex h-[calc(100dvh-1rem)] max-w-md flex-col p-6 sm:h-dvh">
      <div className="mb-4 flex shrink-0 items-center justify-between">
        <button
          onClick={() => router.push('/')}
          aria-label="Back to decks"
          className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="flex gap-2">
          {lastReview && (
            <button
              onClick={handleUndo}
              aria-label="Undo last review"
              className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
            >
              <Undo2 size={16} />
            </button>
          )}
          <Link
            href={`/review/${params.deckId}/all`}
            aria-label="View all cards"
            className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
          >
            <List size={16} />
          </Link>
          <Link
            href={`/review/${params.deckId}/browse`}
            aria-label="Browse this deck"
            className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
          >
            <Search size={16} />
          </Link>
          <button
            onClick={() => {
              setCustomStudyError('');
              setShowCustomStudy(true);
            }}
            aria-label="Custom study"
            className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
          >
            <CalendarClock size={16} />
          </button>
          <button
            onClick={openDeckOptions}
            aria-label="Deck options"
            className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
          >
            <Settings size={16} />
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            aria-label="Add a card"
            className="rounded-md border border-neutral-700 p-2 text-neutral-400 hover:text-neutral-200"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>

      {deck && (
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <p className="text-sm text-neutral-500">{deckBreadcrumb(deck.name)}</p>
          <span className="flex gap-2 text-xs font-medium">
            <span className="text-sky-400" title={DECK_COUNT_TOOLTIPS.new}>
              {deckCounts?.newCount ?? 0}
            </span>
            <span className="text-orange-600" title={DECK_COUNT_TOOLTIPS.learning}>
              {deckCounts?.learningCount ?? 0}
            </span>
            <span className="text-olive-300" title={DECK_COUNT_TOOLTIPS.due}>
              {deckCounts?.dueCount ?? 0}
            </span>
          </span>
        </div>
      )}

      {loading && <p className="text-sm text-neutral-500">Loading…</p>}

      {!loading && current && (
        <div className="flex flex-1 flex-col gap-4 overflow-hidden">
          <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-neutral-800 px-4 text-center">
            {/* Each side is its own scroll region (see ScrollFade). The
                min-h-full inner wrapper keeps content vertically centered
                when it fits, but lets it grow past the container and scroll
                from the top when it's too long (avoids flexbox centering
                clipping the top). No vertical padding so content can scroll
                flush to the edges, where ScrollFade draws its hint gradients. */}
            <ScrollFade>
              <div className="flex min-h-full flex-col items-center justify-center">
                {current.cardType === 'cloze' ? (
                  <p className="text-lg">{questionText(current)}</p>
                ) : (
                  <RichText html={questionText(current)} className="text-lg" />
                )}
              </div>
            </ScrollFade>
            {revealed && (
              <>
                <hr className="shrink-0 border-neutral-800" />
                <ScrollFade>
                  <div className="flex min-h-full flex-col items-center justify-center">
                    {current.cardType === 'cloze' ? (
                      <p className="text-lg text-neutral-300">{answerText(current)}</p>
                    ) : (
                      <RichText html={answerText(current)} className="text-lg text-neutral-300" />
                    )}
                  </div>
                </ScrollFade>
              </>
            )}
          </div>

          {!revealed ? (
            <button
              onClick={() => setRevealed(true)}
              className="w-full shrink-0 rounded-md bg-neutral-100 py-3 text-sm font-medium text-neutral-900"
            >
              Show answer
            </button>
          ) : (
            <div className="grid shrink-0 grid-cols-4 gap-2">
              <button
                onClick={() => handleRate(Rating.Again)}
                className="rounded-md bg-red-700 py-3 text-sm"
              >
                Again
              </button>
              <button
                onClick={() => handleRate(Rating.Hard)}
                className="rounded-md bg-orange-700 py-3 text-sm"
              >
                Hard
              </button>
              <button
                onClick={() => handleRate(Rating.Good)}
                className="rounded-md bg-yellow-600 py-3 text-sm"
              >
                Good
              </button>
              <button
                onClick={() => handleRate(Rating.Easy)}
                className="rounded-md bg-green-600 py-3 text-sm"
              >
                Easy
              </button>
            </div>
          )}
        </div>
      )}

      {!loading && !current && (
        <p className="rounded-lg border border-neutral-800 p-8 text-center text-sm text-neutral-400">
          No cards due right now 🎉
        </p>
      )}

      {showAddModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={closeAddModal}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">New card</p>
              <button
                onClick={closeAddModal}
                aria-label="Close"
                className="text-neutral-400 hover:text-neutral-200"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleAddCard} className="space-y-2">
              <div className="flex flex-wrap gap-1 text-xs">
                {(['basic', 'cloze'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => selectCardType(type)}
                    className={`rounded-md px-3 py-1.5 ${
                      newCardType === type
                        ? 'bg-neutral-100 text-neutral-900'
                        : 'border border-neutral-700 text-neutral-400'
                    }`}
                  >
                    {type === 'basic' ? 'Basic' : 'Cloze'}
                  </button>
                ))}
                {noteTypes?.map((nt) => (
                  <button
                    key={nt.id}
                    type="button"
                    onClick={() => selectCardType(nt.id)}
                    className={`rounded-md px-3 py-1.5 ${
                      newCardType === nt.id
                        ? 'bg-neutral-100 text-neutral-900'
                        : 'border border-neutral-700 text-neutral-400'
                    }`}
                  >
                    {nt.name}
                  </button>
                ))}
              </div>

              {selectedNoteType ? (
                <>
                  {/* div, not label: a label forwards clicks to its first
                      labelable descendant, which inside RichTextInput is the
                      Bold toolbar button — clicking the field was toggling
                      bold. contentEditable isn't labelable, so nothing is
                      lost by using a plain div. */}
                  {selectedNoteType.fields.map((fieldName) => (
                    <div key={fieldName}>
                      <span className="text-xs text-neutral-500">
                        {fieldName}
                        <span className="text-neutral-600">
                          {' '}
                          (
                          {[
                            selectedNoteType.questionFields.includes(fieldName) && 'question',
                            selectedNoteType.answerFields.includes(fieldName) && 'answer',
                          ]
                            .filter(Boolean)
                            .join(' + ')}
                          )
                        </span>
                      </span>
                      <div className="mt-0.5">
                        <RichTextInput
                          value={newFields[fieldName] ?? ''}
                          onChange={(html) => {
                            setNewFields((f) => ({ ...f, [fieldName]: html }));
                            setAddCardError('');
                          }}
                        />
                      </div>
                    </div>
                  ))}
                  {selectedNoteType.reversed && (
                    <label className="flex w-fit items-center gap-2 text-xs text-neutral-400">
                      <Checkbox checked={newReversed} onChange={setNewReversed} />
                      Also add the reverse card (answer → question)
                    </label>
                  )}
                </>
              ) : newCardType === 'cloze' ? (
                <>
                  <label className="block">
                    <span className="text-xs text-neutral-500">Text</span>
                    <textarea
                      value={newClozeText}
                      onChange={(e) => {
                        setNewClozeText(e.target.value);
                        setAddCardError('');
                      }}
                      placeholder="The capital of France is {{c1::Paris}}"
                      rows={3}
                      className="mt-0.5 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                    />
                  </label>
                  <p className="text-xs text-neutral-500">
                    Wrap hidden text in <code>{'{{c1::...}}'}</code>.
                  </p>
                </>
              ) : (
                <>
                  {/* divs, not labels — see the custom-fields comment above
                      (label click-forwarding hits the Bold toolbar button). */}
                  <div>
                    <span className="text-xs text-neutral-500">Front</span>
                    <div className="mt-0.5">
                      <RichTextInput
                        value={newFront}
                        onChange={(html) => {
                          setNewFront(html);
                          setAddCardError('');
                        }}
                        placeholder="e.g. 猫"
                      />
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-neutral-500">Back</span>
                    <div className="mt-0.5">
                      <RichTextInput
                        value={newBack}
                        onChange={(html) => {
                          setNewBack(html);
                          setAddCardError('');
                        }}
                        placeholder="e.g. cat"
                      />
                    </div>
                  </div>
                  <label className="flex w-fit items-center gap-2 text-xs text-neutral-400">
                    <Checkbox checked={newReversed} onChange={setNewReversed} />
                    Also add the reverse card (back → front)
                  </label>
                </>
              )}

              {/* div, not label: with chips present, a label's click-forward
                  target would be the first chip's remove button. */}
              <div>
                <span className="text-xs text-neutral-500">Tags</span>
                <div className="mt-0.5">
                  <TagsInput
                    value={newTags}
                    onChange={setNewTags}
                    placeholder="Type a tag, press Enter…"
                  />
                </div>
              </div>

              {addCardError && <p className="text-sm text-red-400">{addCardError}</p>}

              <button
                type="submit"
                className="w-full rounded-md bg-neutral-100 py-2 text-sm font-medium text-neutral-900"
              >
                Create
              </button>
            </form>
          </div>
        </div>
      )}

      {showDeckOptions && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => {
            setShowDeckOptions(false);
            setDeckOptionsError('');
          }}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">
                {deck && deckParentName(deck.name) ? 'Subdeck options' : 'Deck options'}
              </p>
              <button
                onClick={() => {
                  setShowDeckOptions(false);
                  setDeckOptionsError('');
                }}
                aria-label="Close"
                className="text-neutral-400 hover:text-neutral-200"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSaveDeckOptions} className="space-y-3">
              <label className="block">
                <span className="text-xs text-neutral-400">Name</span>
                <input
                  value={deckNameInput}
                  onChange={(e) => {
                    setDeckNameInput(e.target.value);
                    setDeckOptionsError('');
                  }}
                  className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-neutral-400">New cards/day</span>
                <input
                  type="number"
                  min={0}
                  value={newCardsPerDay}
                  onChange={(e) => {
                    setNewCardsPerDay(Number(e.target.value));
                    setDeckOptionsError('');
                  }}
                  className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-neutral-400">Max reviews/day</span>
                <input
                  type="number"
                  min={0}
                  value={reviewsPerDay}
                  onChange={(e) => {
                    setReviewsPerDay(Number(e.target.value));
                    setDeckOptionsError('');
                  }}
                  className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                />
              </label>
              {deckOptionsError && <p className="text-sm text-red-400">{deckOptionsError}</p>}
              <button
                type="submit"
                className="w-full rounded-md bg-neutral-100 py-2 text-sm font-medium text-neutral-900"
              >
                Save
              </button>
            </form>
          </div>
        </div>
      )}

      {showCustomStudy && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => {
            setShowCustomStudy(false);
            setCustomStudyError('');
          }}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">Custom study</p>
              <button
                onClick={() => {
                  setShowCustomStudy(false);
                  setCustomStudyError('');
                }}
                aria-label="Close"
                className="text-neutral-400 hover:text-neutral-200"
              >
                <X size={16} />
              </button>
            </div>

            <p className="mb-3 text-xs text-neutral-500">
              Review cards ahead of schedule, bypassing today's limits. Cards you rate get
              rescheduled from now, same as any other review.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleStartCustomStudy();
              }}
            >
              <label className="block">
                <span className="text-xs text-neutral-400">Days ahead</span>
                <input
                  type="number"
                  min={0}
                  value={studyAheadDays}
                  onChange={(e) => {
                    setStudyAheadDays(Number(e.target.value));
                    setCustomStudyError('');
                  }}
                  className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                />
              </label>
              {customStudyError && <p className="mt-2 text-sm text-red-400">{customStudyError}</p>}
              <button
                type="submit"
                className="mt-3 w-full rounded-md bg-neutral-100 py-2 text-sm font-medium text-neutral-900"
              >
                Start
              </button>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
