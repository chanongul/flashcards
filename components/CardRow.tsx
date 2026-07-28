'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Pencil, Trash2, Star, Ban, Info, Bug, MoreVertical, Copy, ChevronDown, ArrowLeft } from 'lucide-react';
import { db, type Card, type FieldType } from '@/lib/db';
import { stateLabel, ratingLabel, type StateLabel } from '@/lib/fsrs';
import { clozeQuestion, clozeQuestionFor } from '@/lib/cloze';
import { cardFrontHtml, cardBackHtml } from '@/lib/cardContent';
import { getCardReviewHistory, type ReviewHistoryEntry } from '@/lib/stats';
import { flattenDeckTree, deckDisplayName } from '@/lib/decks';
import { extractSearchableText } from '@/lib/sanitize';
import { inferFieldType } from './MediaFieldInput';
import { useLoading, useLoadingWhen } from './GlobalLoading';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { CardForm } from './CardForm';
import { CardFaces } from './CardFaces';
import { Modal } from './base/Modal';
import { DropdownMenu } from './base/DropdownMenu';


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
    changes: Partial<{
      front: string;
      back: string;
      fields: Record<string, string>;
      tags: string[];
      reversed: boolean;
    }>
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
  const [showClonePicker, setShowClonePicker] = useState(false);
  const [cloneTargetDeckId, setCloneTargetDeckId] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  // Only the preview modal's own Edit button sets this — it's what decides
  // whether the edit modal shows a "back to preview" button or not (opening
  // edit straight from the "..." menu has no preview to go back to).
  const [editedFromPreview, setEditedFromPreview] = useState(false);
  const [history, setHistory] = useState<ReviewHistoryEntry[] | null>(null);
  const { withLoading } = useLoading();
  useLoadingWhen(showInfo && !history);

  useBodyScrollLock(showInfo || showClonePicker || showPreview || editing);

  const hasReversedSibling = useLiveQuery(
    async () => {
      const sib = await db.cards.get(`${card.noteId}::reversed`);
      return !!(sib && !sib.deleted);
    },
    [card.noteId]
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

  function startEdit() {
    setEditedFromPreview(false);
    setEditing(true);
  }

  return (
    <li
      onClick={() => setShowPreview(true)}
      className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border border-neutral-800 px-3 py-2 text-sm hover:bg-neutral-900/50 ${
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
      <DropdownMenu
        stopClickPropagation
        trigger={({ onClick }) => (
          <button
            onClick={onClick}
            aria-label="Card actions"
            className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-400 hover:text-neutral-200"
          >
            <MoreVertical size={16} />
          </button>
        )}
      >
        {(close) => (
          <>
            <button
              onClick={() => {
                setShowInfo(true);
                close();
              }}
              aria-label="Card info"
              className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
            >
              <Info size={14} />
            </button>
            <button
              onClick={() => {
                onToggleFlag(card);
                close();
              }}
              aria-label={card.flagged ? 'Remove flag' : 'Flag card'}
              className={`flex h-8 w-8 items-center justify-center rounded-md hover:bg-neutral-900 ${
                card.flagged ? 'text-yellow-400' : 'text-neutral-300'
              }`}
            >
              <Star size={14} fill={card.flagged ? 'currentColor' : 'none'} />
            </button>
            <button
              onClick={() => {
                onToggleSuspend(card);
                close();
              }}
              aria-label={card.suspended ? 'Unsuspend card' : 'Suspend card'}
              className={`flex h-8 w-8 items-center justify-center rounded-md hover:bg-neutral-900 ${
                card.suspended ? 'text-orange-400' : 'text-neutral-300'
              }`}
            >
              <Ban size={14} />
            </button>
            <button
              onClick={() => {
                openClonePicker();
                close();
              }}
              aria-label="Duplicate card"
              className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
            >
              <Copy size={14} />
            </button>
            <button
              onClick={() => {
                startEdit();
                close();
              }}
              aria-label="Edit card"
              className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
            >
              <Pencil size={14} />
            </button>
            {!isDerivedCard(card) && (
              <button
                onClick={() => {
                  onDelete(card.noteId);
                  close();
                }}
                aria-label="Delete card"
                className="flex h-8 w-8 items-center justify-center rounded-md text-red-400 hover:bg-neutral-900"
              >
                <Trash2 size={14} />
              </button>
            )}
          </>
        )}
      </DropdownMenu>

      <Modal
        open={editing}
        onClose={() => {
          setEditing(false);
          setEditedFromPreview(false);
        }}
        title="Edit card"
        leading={
          editedFromPreview && (
            <button
              onClick={() => {
                setEditing(false);
                setEditedFromPreview(false);
                setShowPreview(true);
              }}
              aria-label="Back to preview"
              className="text-neutral-400 hover:text-neutral-200"
            >
              <ArrowLeft size={16} />
            </button>
          )
        }
      >
        <CardForm
          mode="edit"
          initialCardType={card.cardType === 'custom' ? (card.noteTypeId ?? 'basic') : card.cardType}
          initialFront={card.front}
          initialBack={card.back}
          initialFields={card.fields}
          initialTags={card.tags}
          initialReversed={hasReversedSibling}
          onSubmit={async (data) => {
            await onSave(card.noteId, {
              front: data.front,
              back: data.back,
              fields: data.fields,
              tags: data.tags,
              reversed: data.reversed,
            });
            setEditing(false);
            setEditedFromPreview(false);
          }}
          onCancel={() => {
            setEditing(false);
            setEditedFromPreview(false);
          }}
        />
      </Modal>

      <Modal
        open={showPreview}
        onClose={() => setShowPreview(false)}
        title="Card preview"
        size="bounded"
        trailing={
          <button
            onClick={() => {
              setShowPreview(false);
              setEditedFromPreview(true);
              setEditing(true);
            }}
            aria-label="Edit card"
            className="text-neutral-400 hover:text-neutral-200"
          >
            <Pencil size={12} />
          </button>
        }
      >
        <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 px-4 text-center">
          <CardFaces front={cardFrontHtml(card)} back={cardBackHtml(card)} showBack />
        </div>
      </Modal>

      <Modal
        open={showInfo}
        onClose={() => setShowInfo(false)}
        title="Card info"
        maxHeightClassName="max-h-[80vh]"
      >
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
      </Modal>

      <Modal
        open={showClonePicker}
        onClose={() => setShowClonePicker(false)}
        title="Duplicate card"
        size="fit"
      >
        <label className="block">
          <span className="text-xs text-neutral-500">Deck</span>
          <div className="relative mt-0.5">
            <select
              value={cloneTargetDeckId}
              onChange={(e) => setCloneTargetDeckId(e.target.value)}
              className="w-full appearance-none rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 pr-8 text-sm"
            >
              {deckRows.map(({ deck, depth }) => (
                <option key={deck.id} value={deck.id}>
                  {'  '.repeat(depth)}
                  {deckDisplayName(deck.name)}
                </option>
              ))}
            </select>
            <ChevronDown
              size={14}
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500"
            />
          </div>
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
      </Modal>
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
