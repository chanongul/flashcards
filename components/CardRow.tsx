'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Pencil, Trash2, Star, Ban, Info, X, Bug } from 'lucide-react';
import { db, type Card } from '@/lib/db';
import { stateLabel, ratingLabel, type StateLabel } from '@/lib/fsrs';
import { clozeQuestion, clozeQuestionFor, hasClozeDeletion } from '@/lib/cloze';
import { getCardReviewHistory, type ReviewHistoryEntry } from '@/lib/stats';
import { RichTextInput } from './RichTextInput';
import { stripHtml } from '@/lib/sanitize';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';

const STATE_COLORS: Record<StateLabel, string> = {
  New: 'bg-blue-900/50 text-blue-300',
  Learning: 'bg-orange-900/50 text-orange-300',
  Review: 'bg-green-900/50 text-green-300',
  Relearning: 'bg-red-900/50 text-red-300',
};

function parseTagList(s: string): string[] {
  return Array.from(new Set(s.split(',').map((t) => t.trim()).filter(Boolean)));
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
}

export function CardRow({ card, deckName, onSave, onDelete, onToggleFlag, onToggleSuspend }: CardRowProps) {
  const [editing, setEditing] = useState(false);
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(card.fields);
  const [tagsInput, setTagsInput] = useState(card.tags.join(', '));
  const [editError, setEditError] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const [history, setHistory] = useState<ReviewHistoryEntry[] | null>(null);

  useBodyScrollLock(showInfo);

  const noteType = useLiveQuery(
    () => (card.noteTypeId ? db.noteTypes.get(card.noteTypeId) : undefined),
    [card.noteTypeId]
  );

  useEffect(() => {
    if (!showInfo) return;
    getCardReviewHistory(card.id).then(setHistory);
  }, [showInfo, card.id]);

  function startEdit() {
    setFront(card.front);
    setBack(card.back);
    setFieldValues(card.fields);
    setTagsInput(card.tags.join(', '));
    setEditError('');
    setEditing(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const tags = parseTagList(tagsInput);
    // Content belongs to the note, not this specific derived card — for cloze
    // cards, card.id is `${noteId}::${clozeIndex}`, which wouldn't match
    // anything during replay's note-content pass.
    if (card.cardType === 'custom') {
      const fields = (noteType?.fields ?? []).map((f) => fieldValues[f] ?? '');
      if (fields.every((v) => !stripHtml(v).trim())) {
        setEditError('Fill in at least one field.');
        return;
      }
      await onSave(card.noteId, { fields: fieldValues, tags });
    } else if (card.cardType === 'cloze') {
      if (!front.trim()) {
        setEditError('Enter the cloze text.');
        return;
      }
      if (!hasClozeDeletion(front)) {
        setEditError('Wrap at least one hidden word in {{c1::...}}.');
        return;
      }
      await onSave(card.noteId, { front: front.trim(), back: back.trim(), tags });
    } else {
      if (!stripHtml(front).trim() || !stripHtml(back).trim()) {
        setEditError('Fill in both front and back.');
        return;
      }
      await onSave(card.noteId, { front: front.trim(), back: back.trim(), tags });
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <li>
        <form onSubmit={handleSubmit} className="space-y-2 rounded-md border border-neutral-700 p-3">
          {card.cardType === 'custom' ? (
            (noteType?.fields ?? []).map((fieldName) => (
              <label key={fieldName} className="block">
                <span className="text-xs text-neutral-500">{fieldName}</span>
                <div className="mt-0.5">
                  <RichTextInput
                    value={fieldValues[fieldName] ?? ''}
                    onChange={(html) => {
                      setFieldValues((f) => ({ ...f, [fieldName]: html }));
                      setEditError('');
                    }}
                  />
                </div>
              </label>
            ))
          ) : card.cardType === 'cloze' ? (
            // Cloze syntax ({{c1::...}}) is plain text — rich text markup would
            // conflict with the regex-based cloze parsing.
            <input
              value={front}
              onChange={(e) => {
                setFront(e.target.value);
                setEditError('');
              }}
              className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
            />
          ) : (
            <>
              <RichTextInput
                value={front}
                onChange={(html) => {
                  setFront(html);
                  setEditError('');
                }}
              />
              <RichTextInput
                value={back}
                onChange={(html) => {
                  setBack(html);
                  setEditError('');
                }}
              />
            </>
          )}
          <input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="Tags, comma-separated"
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs"
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
            : stripHtml(card.isReversed ? card.back : card.front)}
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
      <div className="flex shrink-0 gap-2 text-neutral-400">
        <button
          onClick={() => setShowInfo(true)}
          aria-label="Card info"
          className="hover:text-neutral-200"
        >
          <Info size={14} />
        </button>
        <button
          onClick={() => onToggleFlag(card)}
          aria-label={card.flagged ? 'Remove flag' : 'Flag card'}
          className={card.flagged ? 'text-yellow-400' : 'hover:text-neutral-200'}
        >
          <Star size={14} fill={card.flagged ? 'currentColor' : 'none'} />
        </button>
        <button
          onClick={() => onToggleSuspend(card)}
          aria-label={card.suspended ? 'Unsuspend card' : 'Suspend card'}
          className={card.suspended ? 'text-orange-400' : 'hover:text-neutral-200'}
        >
          <Ban size={14} />
        </button>
        <button onClick={startEdit} aria-label="Edit card" className="hover:text-neutral-200">
          <Pencil size={14} />
        </button>
        <button
          onClick={() => onDelete(card.noteId)}
          aria-label="Delete card"
          className="text-red-400 hover:text-red-300"
        >
          <Trash2 size={14} />
        </button>
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
            {!history ? (
              <p className="text-xs text-neutral-500">Loading…</p>
            ) : history.length === 0 ? (
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
