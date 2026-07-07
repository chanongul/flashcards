'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Plus, X, Undo2, List, Settings, CalendarClock, Search, NotebookPen } from 'lucide-react';
import {
  getDueCards,
  getDueCardsAhead,
  reviewCard,
  undoReview,
  createCard,
  editDeck,
} from '@/lib/actions';
import { Rating, type Grade } from '@/lib/fsrs';
import { db, type Card, type FieldType } from '@/lib/db';
import { useUser } from '@/lib/useUser';
import { useSmartBack } from '@/lib/useSmartBack';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { clozeBlankLetters, buildClozeText, clozeSegments } from '@/lib/cloze';
import { RichText } from '@/components/RichText';
import { FieldTypeToggle, FieldValueInput, fieldHasContent, fieldNeedsLabel } from '@/components/MediaFieldInput';
import { useLoading, useLoadingWhen } from '@/components/GlobalLoading';
import { Checkbox } from '@/components/Checkbox';
import { TagsInput } from '@/components/TagsInput';
import { ScrollFade } from '@/components/ScrollFade';
import { ClozeEditor } from '@/components/ClozeEditor';
import { JotPad } from '@/components/JotPad';
import { resolvePendingMediaInHtml } from '@/lib/mediaSync';
import { countCardsByState, DECK_COUNT_TOOLTIPS, type DeckCounts } from '@/lib/stats';
import { deckBreadcrumb, deckDisplayName, deckParentName, getDeckAndDescendantIds } from '@/lib/decks';

function questionText(card: Card): string {
  if (card.isReversed) return card.back;
  return card.front;
}

function answerText(card: Card): string {
  if (card.isReversed) return card.front;
  return card.back;
}

// The cloze review UI (see below) lets the user type into the active blank
// themselves rather than showing "[...]" — self-graded, so the typed value
// is never checked, just a scratchpad for their own recall that gets shown
// back to them (see ClozeRevealPart) once they hit "Show answer". Every
// other cloze number already revealed stays plain text, matching Anki's
// "other deletions shown as context" behavior.
function ClozeFillIn({
  text,
  activeIndex,
  values,
  onChange,
}: {
  text: string;
  activeIndex: number;
  values: string[];
  onChange: (index: number, value: string) => void;
}) {
  let blankCount = 0;
  return (
    <p className="text-lg">
      {clozeSegments(text).map((seg, i) => {
        if (seg.type === 'text') return <span key={i}>{seg.value}</span>;
        if (seg.number !== activeIndex) return <span key={i}>{seg.answer}</span>;
        const index = blankCount;
        blankCount += 1;
        return (
          <input
            key={i}
            type="text"
            value={values[index] ?? ''}
            onChange={(e) => onChange(index, e.target.value)}
            autoFocus={index === 0}
            aria-label="Fill in the blank"
            className="mx-1 w-32 rounded-none border-0 border-b-2 border-neutral-600 bg-transparent px-1 py-0.5 text-center text-lg text-neutral-100 focus:border-neutral-300 focus:outline-none"
          />
        );
      })}
    </p>
  );
}

// One color per blank *occurrence* (not per section) — cycled by index, and
// looked up with the same index in both the user-filled and answer parts —
// so a sentence that repeats the same cloze number more than once still
// lets the user tell which occurrence's typed answer lines up with which
// occurrence's correct answer, rather than every blank looking identical.
const CLOZE_COLORS = [
  'bg-sky-900/60 text-sky-300',
  'bg-green-900/60 text-green-300',
  'bg-amber-900/60 text-amber-300',
  'bg-purple-900/60 text-purple-300',
  'bg-pink-900/60 text-pink-300',
  'bg-teal-900/60 text-teal-300',
  'bg-orange-900/60 text-orange-300',
  'bg-indigo-900/60 text-indigo-300',
];

// The "Show answer" pair for a cloze card: the upper part freezes what the
// user typed into each blank (dash if they left one empty), the lower part
// shows the correct answer. Same sentence, same non-active-number context
// text, rendered twice.
function ClozeRevealPart({
  text,
  activeIndex,
  mode,
  userValues,
}: {
  text: string;
  activeIndex: number;
  mode: 'user' | 'answer';
  userValues: string[];
}) {
  let blankCount = 0;
  return (
    <p className="text-lg">
      {clozeSegments(text).map((seg, i) => {
        if (seg.type === 'text') return <span key={i}>{seg.value}</span>;
        if (seg.number !== activeIndex) return <span key={i}>{seg.answer}</span>;
        const index = blankCount;
        blankCount += 1;
        const value = mode === 'user' ? userValues[index]?.trim() || '—' : seg.answer;
        const color = CLOZE_COLORS[index % CLOZE_COLORS.length];
        return (
          <span key={i} className={`rounded px-1.5 ${color}`}>
            {value}
          </span>
        );
      })}
    </p>
  );
}

export default function ReviewPage() {
  const params = useParams<{ deckId: string }>();
  const goBack = useSmartBack('/');
  const { user, loading: userLoading } = useUser();
  const { withLoading } = useLoading();
  const [queue, setQueue] = useState<Card[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [clozeUserInputs, setClozeUserInputs] = useState<string[]>([]);

  // 'basic' | 'cloze', or a NoteType id for a custom type
  const [newCardType, setNewCardType] = useState<string>('basic');
  const [newFront, setNewFront] = useState('');
  const [newBack, setNewBack] = useState('');
  // Basic has no persisted schema to fix a type to — chosen fresh each time,
  // defaulting to rich text (matches the field's old, only behavior).
  const [newFrontType, setNewFrontType] = useState<FieldType>('richtext');
  const [newBackType, setNewBackType] = useState<FieldType>('richtext');
  const [newReversed, setNewReversed] = useState(false);
  const [newClozeText, setNewClozeText] = useState('');
  const [newClozeAnswers, setNewClozeAnswers] = useState<Record<string, string>>({});
  const [newClozeSeparateCards, setNewClozeSeparateCards] = useState(false);
  const [newFields, setNewFields] = useState<Record<string, string>>({});
  // Only used for custom fields declared 'dynamic' in their note type —
  // fixed-type fields never read from this.
  const [newFieldTypes, setNewFieldTypes] = useState<Record<string, FieldType>>({});
  const [newTags, setNewTags] = useState<string[]>([]);
  const [addCardError, setAddCardError] = useState('');

  const noteTypes = useLiveQuery(() => db.noteTypes.filter((nt) => !nt.deleted).toArray(), []);
  const selectedNoteType = noteTypes?.find((nt) => nt.id === newCardType);

  function resolvedNewFieldType(fieldName: string): FieldType {
    const config = selectedNoteType?.fieldTypes?.[fieldName] ?? 'richtext';
    if (config === 'dynamic') return newFieldTypes[fieldName] ?? 'richtext';
    return config;
  }

  const [showJot, setShowJot] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDeckOptions, setShowDeckOptions] = useState(false);
  const [showStudyAhead, setShowStudyAhead] = useState(false);

  useBodyScrollLock(showAddModal || showDeckOptions || showStudyAhead);

  const [deckNameInput, setDeckNameInput] = useState('');
  const [newCardsPerDay, setNewCardsPerDay] = useState(0);
  const [reviewsPerDay, setReviewsPerDay] = useState(0);
  const [studyAheadDays, setStudyAheadDays] = useState(1);
  const [deckOptionsError, setDeckOptionsError] = useState('');
  const [studyAheadError, setStudyAheadError] = useState('');

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
  // Overrides deckCounts while a "study ahead" session is active — see
  // handleStartStudyAhead. Plain state, not persisted, so a refresh drops
  // back to the live "due right now" counts.
  const [aheadCounts, setAheadCounts] = useState<DeckCounts | null>(null);

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

  // A fresh card (including moving to the next one after rating) starts
  // with empty blanks — without this, stale input from the previous cloze
  // card would otherwise carry over since clozeUserInputs is plain state,
  // not per-card.
  useEffect(() => {
    setClozeUserInputs([]);
  }, [current?.id]);

  function handleClozeInputChange(index: number, value: string) {
    setClozeUserInputs((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

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
    setNewFrontType('richtext');
    setNewBackType('richtext');
    setNewReversed(false);
    setNewClozeText('');
    setNewClozeAnswers({});
    setNewClozeSeparateCards(false);
    setNewFields({});
    setNewFieldTypes({});
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
      const isFilled = (f: string) => fieldHasContent(newFields[f] ?? '', resolvedNewFieldType(f));
      const missingLabelField = selectedNoteType.fields.find((f) =>
        fieldNeedsLabel(newFields[f] ?? '', resolvedNewFieldType(f))
      );
      if (missingLabelField) {
        setAddCardError(`Add a label for "${missingLabelField}" (used for search).`);
        return;
      }
      if (!selectedNoteType.questionFields.some(isFilled)) {
        setAddCardError('Fill in at least one question field.');
        return;
      }
      if (!selectedNoteType.answerFields.some(isFilled)) {
        setAddCardError('Fill in at least one answer field.');
        return;
      }
      // Any image/audio inserted while composing this card was only ever
      // queued locally (see RichTextInput) — resolve it to a real upload
      // now that the card is actually being saved, so an abandoned edit
      // never leaves an orphaned file in R2.
      await withLoading(async () => {
        const resolvedFields = Object.fromEntries(
          await Promise.all(
            Object.entries(newFields).map(async ([key, val]) => [key, await resolvePendingMediaInHtml(val)])
          )
        );
        await createCard(
          user.id,
          params.deckId,
          selectedNoteType.id,
          '',
          '',
          tags,
          resolvedFields,
          newReversed
        );
      });
    } else if (newCardType === 'cloze') {
      if (!newClozeText.trim()) {
        setAddCardError('Enter the cloze text.');
        return;
      }
      const letters = clozeBlankLetters(newClozeText);
      if (letters.length === 0) {
        setAddCardError('Click + to mark at least one blank.');
        return;
      }
      if (letters.some((letter) => !newClozeAnswers[letter]?.trim())) {
        setAddCardError('Fill in an answer for every blank.');
        return;
      }
      const clozeText = buildClozeText(newClozeText, newClozeAnswers, newClozeSeparateCards);
      await withLoading(() => createCard(user.id, params.deckId, 'cloze', clozeText.trim(), '', tags));
    } else {
      if (fieldNeedsLabel(newFront, newFrontType)) {
        setAddCardError('Add a label for the front (used for search).');
        return;
      }
      if (fieldNeedsLabel(newBack, newBackType)) {
        setAddCardError('Add a label for the back (used for search).');
        return;
      }
      if (!fieldHasContent(newFront, newFrontType) || !fieldHasContent(newBack, newBackType)) {
        setAddCardError('Fill in both front and back.');
        return;
      }
      await withLoading(async () => {
        const resolvedFront = await resolvePendingMediaInHtml(newFront);
        const resolvedBack = await resolvePendingMediaInHtml(newBack);
        await createCard(
          user.id,
          params.deckId,
          newCardType,
          resolvedFront,
          resolvedBack,
          tags,
          undefined,
          newReversed
        );
      });
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

  async function handleStartStudyAhead() {
    if (studyAheadDays < 0) {
      setStudyAheadError('Days ahead cannot be negative.');
      return;
    }
    const cutoff = Date.now() + studyAheadDays * 24 * 60 * 60 * 1000;
    const ahead = await getDueCardsAhead(params.deckId, studyAheadDays);
    setQueue(ahead);
    setRevealed(false);
    setShowStudyAhead(false);
    // Swap the New/Learning/Due badges to reflect this wider window instead
    // of just what's due right now — otherwise reviewing cards that aren't
    // actually due today would never move any visible number, since they
    // were never counted as due in the first place. Goes back to the live
    // "due right now" counts on refresh (this is plain component state, not
    // persisted) — see aheadCounts below.
    setAheadCounts(countCardsByState(ahead, cutoff));
  }

  useLoadingWhen(userLoading || !user);
  useLoadingWhen(loading);

  if (userLoading || !user) {
    return null;
  }

  return (
    <main className="mx-auto flex h-[calc(100dvh-1rem)] max-w-md flex-col p-6 sm:h-dvh">
      <div className="mb-4 flex shrink-0 items-center justify-between">
        <button
          onClick={goBack}
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
              setStudyAheadError('');
              setShowStudyAhead(true);
            }}
            aria-label="Study ahead"
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
          <div className="flex items-center gap-2">
            <span className="flex gap-2 text-xs font-medium">
              <span className="text-sky-400" title={DECK_COUNT_TOOLTIPS.new}>
                {(aheadCounts ?? deckCounts)?.newCount ?? 0}
              </span>
              <span className="text-orange-600" title={DECK_COUNT_TOOLTIPS.learning}>
                {(aheadCounts ?? deckCounts)?.learningCount ?? 0}
              </span>
              <span className="text-olive-300" title={DECK_COUNT_TOOLTIPS.due}>
                {(aheadCounts ?? deckCounts)?.dueCount ?? 0}
              </span>
            </span>
            <button
              onClick={() => setShowJot((v) => !v)}
              aria-label={showJot ? 'Hide jot sheet' : 'Show jot sheet'}
              aria-pressed={showJot}
              className={showJot ? 'text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'}
            >
              <NotebookPen size={16} />
            </button>
          </div>
        </div>
      )}

      {showJot && current && (
        <div className="mb-4 shrink-0" key={current.id}>
          <JotPad />
        </div>
      )}

      {!loading && current && (
        <div className="flex flex-1 flex-col gap-4 overflow-hidden">
          <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-neutral-800 px-4 text-center">
            {/* Each side is its own scroll region (see ScrollFade). The
                min-h-full inner wrapper keeps content vertically centered
                when it fits, but lets it grow past the container and scroll
                from the top when it's too long (avoids flexbox centering
                clipping the top). No vertical padding so content can scroll
                flush to the edges, where ScrollFade draws its hint gradients. */}
            {current.cardType === 'cloze' ? (
              <>
                <ScrollFade>
                  <div className="flex min-h-full flex-col items-center justify-center">
                    {revealed ? (
                      <ClozeRevealPart
                        text={current.front}
                        activeIndex={current.clozeIndex ?? 1}
                        mode="user"
                        userValues={clozeUserInputs}
                      />
                    ) : (
                      <ClozeFillIn
                        key={current.id}
                        text={current.front}
                        activeIndex={current.clozeIndex ?? 1}
                        values={clozeUserInputs}
                        onChange={handleClozeInputChange}
                      />
                    )}
                  </div>
                </ScrollFade>
                {revealed && (
                  <>
                    <hr className="shrink-0 border-neutral-800" />
                    <ScrollFade>
                      <div className="flex min-h-full flex-col items-center justify-center">
                        <ClozeRevealPart
                          text={current.front}
                          activeIndex={current.clozeIndex ?? 1}
                          mode="answer"
                          userValues={clozeUserInputs}
                        />
                      </div>
                    </ScrollFade>
                  </>
                )}
              </>
            ) : (
              <>
                <ScrollFade>
                  <div className="flex min-h-full flex-col items-center justify-center">
                    <RichText html={questionText(current)} className="text-lg" />
                  </div>
                </ScrollFade>
                {revealed && (
                  <>
                    <hr className="shrink-0 border-neutral-800" />
                    <ScrollFade>
                      <div className="flex min-h-full flex-col items-center justify-center">
                        <RichText html={answerText(current)} className="text-lg text-neutral-300" />
                      </div>
                    </ScrollFade>
                  </>
                )}
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
            className="max-h-[85vh] w-full max-w-sm overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-4"
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
                  {selectedNoteType.fields.map((fieldName) => {
                    const isDynamic = (selectedNoteType.fieldTypes?.[fieldName] ?? 'richtext') === 'dynamic';
                    const type = resolvedNewFieldType(fieldName);
                    return (
                      <div key={fieldName}>
                        <div className="flex items-center justify-between gap-2">
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
                          {isDynamic && (
                            <FieldTypeToggle
                              value={type}
                              onChange={(t) => {
                                setNewFieldTypes((f) => ({ ...f, [fieldName]: t }));
                                setNewFields((f) => ({ ...f, [fieldName]: '' }));
                              }}
                            />
                          )}
                        </div>
                        <div className="mt-0.5">
                          <FieldValueInput
                            type={type}
                            value={newFields[fieldName] ?? ''}
                            onChange={(html) => {
                              setNewFields((f) => ({ ...f, [fieldName]: html }));
                              setAddCardError('');
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                  {selectedNoteType.reversed && (
                    <label className="flex w-fit items-center gap-2 text-xs text-neutral-400">
                      <Checkbox checked={newReversed} onChange={setNewReversed} />
                      Also add the reverse card (answer → question)
                    </label>
                  )}
                </>
              ) : newCardType === 'cloze' ? (
                <ClozeEditor
                  initialText=""
                  initialAnswers={{}}
                  initialSeparateCards={false}
                  onChange={(text, answers, separateCards) => {
                    setNewClozeText(text);
                    setNewClozeAnswers(answers);
                    setNewClozeSeparateCards(separateCards);
                    setAddCardError('');
                  }}
                />
              ) : (
                <>
                  {/* divs, not labels — see the custom-fields comment above
                      (label click-forwarding hits the Bold toolbar button). */}
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-neutral-500">Front</span>
                      <FieldTypeToggle
                        value={newFrontType}
                        onChange={(t) => {
                          setNewFrontType(t);
                          setNewFront('');
                        }}
                      />
                    </div>
                    <div className="mt-0.5">
                      <FieldValueInput
                        type={newFrontType}
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
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-neutral-500">Back</span>
                      <FieldTypeToggle
                        value={newBackType}
                        onChange={(t) => {
                          setNewBackType(t);
                          setNewBack('');
                        }}
                      />
                    </div>
                    <div className="mt-0.5">
                      <FieldValueInput
                        type={newBackType}
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
            className="max-h-[85vh] w-full max-w-sm overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-4"
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

      {showStudyAhead && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => {
            setShowStudyAhead(false);
            setStudyAheadError('');
          }}
        >
          <div
            className="max-h-[85vh] w-full max-w-sm overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">Study ahead</p>
              <button
                onClick={() => {
                  setShowStudyAhead(false);
                  setStudyAheadError('');
                }}
                aria-label="Close"
                className="text-neutral-400 hover:text-neutral-200"
              >
                <X size={16} />
              </button>
            </div>

            <p className="mb-3 text-xs text-neutral-500">
              Review cards ahead of schedule, bypassing today's limits. Cards you rate get
              rescheduled from now, same as any other review. This session isn't saved —
              refreshing the page ends it and goes back to what's actually due today.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleStartStudyAhead();
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
                    setStudyAheadError('');
                  }}
                  className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                />
              </label>
              {studyAheadError && <p className="mt-2 text-sm text-red-400">{studyAheadError}</p>}
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
