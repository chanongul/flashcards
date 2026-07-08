'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Pencil, Trash2, Star, Ban, Info, X, Bug, MoreVertical, Copy } from 'lucide-react';
import { db, type Card, type FieldType } from '@/lib/db';
import { stateLabel, ratingLabel, type StateLabel } from '@/lib/fsrs';
import { clozeQuestion, clozeQuestionFor, clozeBlankLetters, buildClozeText, parseClozeToDraft } from '@/lib/cloze';
import { getCardReviewHistory, type ReviewHistoryEntry } from '@/lib/stats';
import { flattenDeckTree, deckDisplayName } from '@/lib/decks';
import { shouldDropUp } from '@/lib/dropdownMenu';
import {
  FieldTypeToggle,
  FieldValueInput,
  inferFieldType,
  fieldHasContent,
  fieldNeedsLabel,
  reconcileFieldValues,
} from './MediaFieldInput';
import { extractSearchableText } from '@/lib/sanitize';
import { resolvePendingMediaInHtml } from '@/lib/mediaSync';
import { useLoading, useLoadingWhen } from './GlobalLoading';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { ClozeEditor } from './ClozeEditor';
import { TagsInput } from './TagsInput';

const STATE_COLORS: Record<StateLabel, string> = {
  New: 'bg-sky-900/50 text-sky-300',
  Learning: 'bg-orange-900/50 text-orange-300',
  Review: 'bg-olive-900/50 text-olive-300',
  Relearning: 'bg-red-900/50 text-red-300',
};

function parseTagList(s: string): string[] {
  return Array.from(new Set(s.split(',').map((t) => t.trim()).filter(Boolean)));
}

// A reverse card (isReversed) and every non-first cloze blank card
// (clozeIndex > 1) are generated from — and share their content with —
// another card, rather than owning a note of their own. Deleting either
// would need to either delete the whole note (surprising, from a card that
// looks like just one of several) or be disallowed outright, so simplest is
// to only ever offer delete from the one canonical card and let deleting it
// remove the note (and everything generated from it) as usual. Editing is
// unaffected — it already edits the shared note either way.
function isDerivedCard(card: Card): boolean {
  if (card.isReversed) return true;
  if (card.cardType === 'cloze' && card.clozeIndex !== null && card.clozeIndex > 1) return true;
  return false;
}

// extractSearchableText includes a media field's alt/title label, so a
// media-only field previews as its label rather than blank. The bracket
// fallback only matters for media saved before labels existed/were required.
function previewText(html: string): string {
  const text = extractSearchableText(html).trim();
  if (text) return text;
  const type = inferFieldType(html);
  if (type === 'image') return '[Image]';
  if (type === 'audio') return '[Audio]';
  return '';
}

interface CardRowProps {
  card: Card;
  deckName?: string;
  onSave: (
    cardId: string,
    changes: Partial<{ front: string; back: string; fields: Record<string, string>; tags: string[] }>
  ) => void | Promise<void>;
  onDelete: (cardId: string) => void | Promise<void>;
  onToggleFlag: (card: Card) => void | Promise<void>;
  onToggleSuspend: (card: Card) => void | Promise<void>;
  onClone: (cardId: string, deckId: string) => void | Promise<void>;
}

export function CardRow({
  card,
  deckName,
  onSave,
  onDelete,
  onToggleFlag,
  onToggleSuspend,
  onClone,
}: CardRowProps) {
  const [editing, setEditing] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [actionsDropUp, setActionsDropUp] = useState(false);
  const [showClonePicker, setShowClonePicker] = useState(false);
  const [cloneTargetDeckId, setCloneTargetDeckId] = useState('');
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  const [frontType, setFrontType] = useState<FieldType>('richtext');
  const [backType, setBackType] = useState<FieldType>('richtext');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(card.fields);
  const [dynamicFieldTypes, setDynamicFieldTypes] = useState<Record<string, FieldType>>({});
  const [clozeText, setClozeText] = useState('');
  const [clozeAnswers, setClozeAnswers] = useState<Record<string, string>>({});
  const [clozeSeparateCards, setClozeSeparateCards] = useState(false);
  const [tagsInput, setTagsInput] = useState<string[]>(card.tags);
  const [editError, setEditError] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const [history, setHistory] = useState<ReviewHistoryEntry[] | null>(null);
  const { withLoading } = useLoading();
  useLoadingWhen(showInfo && !history);

  useBodyScrollLock(showInfo || showClonePicker);

  const noteType = useLiveQuery(
    () => (card.noteTypeId ? db.noteTypes.get(card.noteTypeId) : undefined),
    [card.noteTypeId]
  );

  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray(), []);
  const deckRows = flattenDeckTree(decks ?? []);

  useEffect(() => {
    if (!showInfo) return;
    getCardReviewHistory(card.id).then(setHistory);
  }, [showInfo, card.id]);

  function openClonePicker() {
    setCloneTargetDeckId(card.deckId);
    setShowClonePicker(true);
  }

  async function handleConfirmClone() {
    if (!cloneTargetDeckId) return;
    await withLoading(() => onClone(card.id, cloneTargetDeckId));
    setShowClonePicker(false);
  }

  // A custom field's config is fixed to one FieldType, or 'dynamic' — in
  // which case it behaves like Basic's Front/Back (chosen per note, here
  // tracked in dynamicFieldTypes and inferred from existing content).
  function resolvedFieldType(fieldName: string): FieldType {
    const config = noteType?.fieldTypes?.[fieldName] ?? 'richtext';
    if (config === 'dynamic') return dynamicFieldTypes[fieldName] ?? 'richtext';
    return config;
  }

  function startEdit() {
    setFront(card.front);
    setBack(card.back);
    setFrontType(inferFieldType(card.front));
    setBackType(inferFieldType(card.back));
    const draft = parseClozeToDraft(card.front);
    setClozeText(draft.template);
    setClozeAnswers(draft.answers);
    setClozeSeparateCards(draft.separateCards);
    // The note type can change after this note was created (fields renamed,
    // or a fixed field's declared type changed) — reconcile against its
    // *current* shape rather than trusting the raw stored values as-is: a
    // renamed-away field's old value is dropped, and a fixed field whose
    // content no longer matches its current type is cleared for re-entry.
    const reconciled = noteType ? reconcileFieldValues(card.fields, noteType) : card.fields;
    setFieldValues(reconciled);
    const dynTypes: Record<string, FieldType> = {};
    for (const f of noteType?.fields ?? []) {
      if ((noteType?.fieldTypes?.[f] ?? 'richtext') === 'dynamic') {
        dynTypes[f] = inferFieldType(reconciled[f] ?? '');
      }
    }
    setDynamicFieldTypes(dynTypes);
    setTagsInput(card.tags);
    setEditError('');
    setEditing(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const tags = tagsInput;
    // Content belongs to the note, not this specific derived card — for cloze
    // cards, card.id is `${noteId}::${clozeIndex}`, which wouldn't match
    // anything during replay's note-content pass.
    if (card.cardType === 'custom') {
      const fields = noteType?.fields ?? [];
      const missingLabelField = fields.find((f) =>
        fieldNeedsLabel(fieldValues[f] ?? '', resolvedFieldType(f))
      );
      if (missingLabelField) {
        setEditError(`Add a label for "${missingLabelField}" (used for search).`);
        return;
      }
      if (fields.every((f) => !fieldHasContent(fieldValues[f] ?? '', resolvedFieldType(f)))) {
        setEditError('Fill in at least one field.');
        return;
      }
      // Any image/audio inserted while editing was only ever queued locally
      // (see MediaFieldInput) — resolve it to a real upload now that the
      // change is actually being saved.
      await withLoading(async () => {
        const resolvedFields = Object.fromEntries(
          await Promise.all(
            Object.entries(fieldValues).map(async ([key, val]) => [key, await resolvePendingMediaInHtml(val)])
          )
        );
        await onSave(card.noteId, { fields: resolvedFields, tags });
      });
    } else if (card.cardType === 'cloze') {
      if (!clozeText.trim()) {
        setEditError('Enter the cloze text.');
        return;
      }
      const letters = clozeBlankLetters(clozeText);
      if (letters.length === 0) {
        setEditError('Click + to mark at least one blank.');
        return;
      }
      if (letters.some((letter) => !clozeAnswers[letter]?.trim())) {
        setEditError('Fill in an answer for every blank.');
        return;
      }
      const finalText = buildClozeText(clozeText, clozeAnswers, clozeSeparateCards);
      await withLoading(() => onSave(card.noteId, { front: finalText.trim(), back: back.trim(), tags }));
    } else {
      if (fieldNeedsLabel(front, frontType)) {
        setEditError('Add a label for the front (used for search).');
        return;
      }
      if (fieldNeedsLabel(back, backType)) {
        setEditError('Add a label for the back (used for search).');
        return;
      }
      if (!fieldHasContent(front, frontType) || !fieldHasContent(back, backType)) {
        setEditError('Fill in both front and back.');
        return;
      }
      await withLoading(async () => {
        const resolvedFront = await resolvePendingMediaInHtml(front.trim());
        const resolvedBack = await resolvePendingMediaInHtml(back.trim());
        await onSave(card.noteId, { front: resolvedFront, back: resolvedBack, tags });
      });
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <li>
        <form onSubmit={handleSubmit} className="space-y-2 rounded-md border border-neutral-700 p-3">
          {card.cardType === 'custom' ? (
            // div, not label: a label forwards clicks to its first labelable
            // descendant — inside RichTextInput that's the Bold toolbar
            // button, so clicking the field was toggling bold.
            (noteType?.fields ?? []).map((fieldName) => {
              const isDynamic = (noteType?.fieldTypes?.[fieldName] ?? 'richtext') === 'dynamic';
              const type = resolvedFieldType(fieldName);
              return (
                <div key={fieldName}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-neutral-500">
                      {fieldName}
                      {noteType && (
                        <span className="text-neutral-600 font-medium">
                          {' '}
                          (
                          {[
                            noteType.questionFields.includes(fieldName) && 'question',
                            noteType.answerFields.includes(fieldName) && 'answer',
                          ]
                            .filter(Boolean)
                            .join(' + ')}
                          )
                        </span>
                      )}
                    </span>
                    {isDynamic && (
                      <FieldTypeToggle
                        value={type}
                        onChange={(t) => {
                          setDynamicFieldTypes((d) => ({ ...d, [fieldName]: t }));
                          setFieldValues((f) => ({ ...f, [fieldName]: '' }));
                        }}
                      />
                    )}
                  </div>
                  <div className="mt-0.5">
                    <FieldValueInput
                      type={type}
                      value={fieldValues[fieldName] ?? ''}
                      onChange={(html) => {
                        setFieldValues((f) => ({ ...f, [fieldName]: html }));
                        setEditError('');
                      }}
                    />
                  </div>
                </div>
              );
            })
          ) : card.cardType === 'cloze' ? (
            <ClozeEditor
              initialText={clozeText}
              initialAnswers={clozeAnswers}
              initialSeparateCards={clozeSeparateCards}
              onChange={(text, answers, separateCards) => {
                setClozeText(text);
                setClozeAnswers(answers);
                setClozeSeparateCards(separateCards);
                setEditError('');
              }}
            />
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-neutral-500">Front</span>
                  <FieldTypeToggle
                    value={frontType}
                    onChange={(t) => {
                      setFrontType(t);
                      setFront('');
                    }}
                  />
                </div>
                <div className="mt-0.5">
                  <FieldValueInput
                    type={frontType}
                    value={front}
                    onChange={(html) => {
                      setFront(html);
                      setEditError('');
                    }}
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-neutral-500">Back</span>
                  <FieldTypeToggle
                    value={backType}
                    onChange={(t) => {
                      setBackType(t);
                      setBack('');
                    }}
                  />
                </div>
                <div className="mt-0.5">
                  <FieldValueInput
                    type={backType}
                    value={back}
                    onChange={(html) => {
                      setBack(html);
                      setEditError('');
                    }}
                  />
                </div>
              </div>
            </>
          )}
          <TagsInput
            value={tagsInput}
            onChange={setTagsInput}
            placeholder="Type a tag, press Enter…"
          />
          {editError && <p className="text-xs text-red-400">{editError}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              className="flex-1 rounded-md bg-neutral-100 py-1.5 text-xs font-medium text-neutral-900"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setEditError('');
              }}
              className="flex-1 rounded-md border border-neutral-700 py-1.5 text-xs text-neutral-300"
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li
      className={`flex items-center justify-between gap-2 rounded-md border border-neutral-800 px-3 py-2 text-sm ${
        card.suspended ? 'opacity-40' : ''
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${STATE_COLORS[stateLabel(card.fsrs.state)]}`}
        >
          {stateLabel(card.fsrs.state)}
        </span>
        <span className="truncate text-neutral-300">
          {card.cardType === 'cloze'
            ? card.clozeIndex !== null
              ? clozeQuestionFor(card.front, card.clozeIndex)
              : clozeQuestion(card.front)
            : previewText(card.isReversed ? card.back : card.front)}
        </span>
        {card.isReversed && <span className="shrink-0 text-xs text-neutral-500">(reversed)</span>}
        {deckName && <span className="shrink-0 text-xs text-neutral-500">· {deckName}</span>}
        {card.tags.length > 0 && (
          <span className="flex shrink-0 gap-1">
            {card.tags.map((tag) => (
              <span
                key={tag}
                className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
              >
                {tag}
              </span>
            ))}
          </span>
        )}
        {card.isLeech && (
          <span className="shrink-0 text-red-400" aria-label="Leech" title="Leech (too many lapses)">
            <Bug size={12} />
          </span>
        )}
        {card.suspended && <span className="shrink-0 text-xs text-neutral-500">(suspended)</span>}
      </span>
      <div className="relative shrink-0">
        <button
          onClick={(e) => {
            const opening = !showActions;
            setShowActions(opening);
            if (opening) setActionsDropUp(shouldDropUp(e.currentTarget.getBoundingClientRect()));
          }}
          aria-label="Card actions"
          className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-400 hover:text-neutral-200"
        >
          <MoreVertical size={16} />
        </button>

        {showActions && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowActions(false)} />
            <div
              className={`absolute right-0 z-50 flex gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-1 shadow-lg ${
                actionsDropUp ? 'bottom-full mb-1' : 'top-full mt-1'
              }`}
            >
              <button
                onClick={() => {
                  setShowInfo(true);
                  setShowActions(false);
                }}
                aria-label="Card info"
                className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
              >
                <Info size={16} />
              </button>
              <button
                onClick={() => {
                  onToggleFlag(card);
                  setShowActions(false);
                }}
                aria-label={card.flagged ? 'Remove flag' : 'Flag card'}
                className={`flex h-9 w-9 items-center justify-center rounded-md hover:bg-neutral-900 ${
                  card.flagged ? 'text-yellow-400' : 'text-neutral-300'
                }`}
              >
                <Star size={16} fill={card.flagged ? 'currentColor' : 'none'} />
              </button>
              <button
                onClick={() => {
                  onToggleSuspend(card);
                  setShowActions(false);
                }}
                aria-label={card.suspended ? 'Unsuspend card' : 'Suspend card'}
                className={`flex h-9 w-9 items-center justify-center rounded-md hover:bg-neutral-900 ${
                  card.suspended ? 'text-orange-400' : 'text-neutral-300'
                }`}
              >
                <Ban size={16} />
              </button>
              <button
                onClick={() => {
                  openClonePicker();
                  setShowActions(false);
                }}
                aria-label="Duplicate card"
                className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
              >
                <Copy size={16} />
              </button>
              <button
                onClick={() => {
                  startEdit();
                  setShowActions(false);
                }}
                aria-label="Edit card"
                className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
              >
                <Pencil size={16} />
              </button>
              {!isDerivedCard(card) && (
                <button
                  onClick={() => {
                    onDelete(card.noteId);
                    setShowActions(false);
                  }}
                  aria-label="Delete card"
                  className="flex h-9 w-9 items-center justify-center rounded-md text-red-400 hover:bg-neutral-900"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {showInfo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShowInfo(false)}
        >
          <div
            className="max-h-[80vh] w-full max-w-sm overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">Card info</p>
              <button
                onClick={() => setShowInfo(false)}
                aria-label="Close"
                className="text-neutral-400 hover:text-neutral-200"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mb-4 grid grid-cols-2 gap-2 text-sm">
              <InfoStat label="State" value={stateLabel(card.fsrs.state)} />
              <InfoStat label="Due" value={new Date(card.fsrs.due).toLocaleString()} />
              <InfoStat label="Stability" value={`${card.fsrs.stability.toFixed(2)}d`} />
              <InfoStat label="Difficulty" value={card.fsrs.difficulty.toFixed(2)} />
              <InfoStat label="Reps" value={String(card.fsrs.reps)} />
              <InfoStat label="Lapses" value={String(card.fsrs.lapses)} />
              <InfoStat
                label="Last reviewed"
                value={card.fsrs.last_review ? new Date(card.fsrs.last_review).toLocaleString() : 'Never'}
              />
            </div>

            <p className="mb-2 text-xs font-medium text-neutral-400">
              Review history {history && `(${history.length})`}
            </p>
            {!history ? null : history.length === 0 ? (
              <p className="text-xs text-neutral-500">No reviews yet.</p>
            ) : (
              <ul className="space-y-1">
                {history.map((entry) => (
                  <li
                    key={entry.id}
                    className={`flex items-center justify-between rounded px-2 py-1 text-xs ${
                      entry.undone ? 'text-neutral-600 line-through' : 'text-neutral-300'
                    }`}
                  >
                    <span>{new Date(entry.timestamp).toLocaleString()}</span>
                    <span>
                      {ratingLabel(entry.rating)}
                      {entry.undone && ' (undone)'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {showClonePicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShowClonePicker(false)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">Duplicate card</p>
              <button
                onClick={() => setShowClonePicker(false)}
                aria-label="Close"
                className="text-neutral-400 hover:text-neutral-200"
              >
                <X size={16} />
              </button>
            </div>
            <label className="block">
              <span className="text-xs text-neutral-500">Deck</span>
              <select
                value={cloneTargetDeckId}
                onChange={(e) => setCloneTargetDeckId(e.target.value)}
                className="mt-0.5 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
              >
                {deckRows.map(({ deck, depth }) => (
                  <option key={deck.id} value={deck.id}>
                    {'  '.repeat(depth)}
                    {deckDisplayName(deck.name)}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-3 flex gap-2">
              <button
                onClick={handleConfirmClone}
                className="flex-1 rounded-md bg-neutral-100 py-2 text-sm font-medium text-neutral-900"
              >
                Duplicate
              </button>
              <button
                onClick={() => setShowClonePicker(false)}
                className="flex-1 rounded-md border border-neutral-700 py-2 text-sm text-neutral-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

function InfoStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-800 p-2">
      <p className="text-sm font-medium">{value}</p>
      <p className="text-[10px] text-neutral-500">{label}</p>
    </div>
  );
}
