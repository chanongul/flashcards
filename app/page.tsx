'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  LogOut,
  Pencil,
  Trash2,
  Check,
  X,
  Search,
  FolderPlus,
  LayoutTemplate,
  Plus,
  MoreVertical,
  Copy,
  ArrowLeft,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Deck, type NoteType } from '@/lib/db';
import {
  createDeck,
  editDeck,
  deleteDeck,
  cloneDeck,
  createNoteType,
  editNoteType,
  deleteNoteType,
  cloneNoteType,
} from '@/lib/actions';
import { useUser } from '@/lib/useUser';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { createClient } from '@/utils/supabase/client';
import { countCardsByState, DECK_COUNT_TOOLTIPS, type DeckCounts } from '@/lib/stats';
import { deckDisplayName, deckParentName, ancestorNames, flattenDeckTree } from '@/lib/decks';
import { ReviewHeatmap } from '@/components/ReviewHeatmap';
import { ConfirmDialog } from '@/components/ConfirmDialog';

// Both action dropdowns are a short single row of h-9 (36px) icon buttons
// plus p-1 padding and a border — comfortably under 60px including margin.
const DROPDOWN_MENU_HEIGHT = 60;

function shouldDropUp(triggerRect: DOMRect): boolean {
  return window.innerHeight - triggerRect.bottom < DROPDOWN_MENU_HEIGHT;
}

export default function HomePage() {
  const { user, loading } = useUser();
  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const [newDeckName, setNewDeckName] = useState('');
  const [createDeckError, setCreateDeckError] = useState('');

  const deckCounts = useLiveQuery(async () => {
    const [allDecks, cards] = await Promise.all([
      db.decks.toArray(),
      db.cards.filter((c) => !c.deleted && !c.suspended).toArray(),
    ]);
    const byDeck = new Map<string, typeof cards>();
    for (const card of cards) {
      const list = byDeck.get(card.deckId) ?? [];
      list.push(card);
      byDeck.set(card.deckId, list);
    }
    const now = Date.now();
    const own = new Map<string, DeckCounts>();
    for (const [deckId, deckCards] of byDeck) {
      own.set(deckId, countCardsByState(deckCards, now));
    }

    // Roll each deck's own counts up into every ancestor, so a parent deck's
    // number reflects its subdecks too (matches Anki's deck-list behavior).
    const aggregated = new Map<string, DeckCounts>();
    for (const deck of allDecks) {
      const zero = { newCount: 0, learningCount: 0, dueCount: 0 };
      aggregated.set(deck.id, { ...(own.get(deck.id) ?? zero) });
    }
    const nameToId = new Map(allDecks.map((d) => [d.name, d.id]));
    for (const deck of allDecks) {
      const deckOwn = own.get(deck.id);
      if (!deckOwn) continue;
      for (const ancestorName of ancestorNames(deck.name)) {
        const ancestorId = nameToId.get(ancestorName);
        if (!ancestorId) continue;
        const agg = aggregated.get(ancestorId)!;
        agg.newCount += deckOwn.newCount;
        agg.learningCount += deckOwn.learningCount;
        agg.dueCount += deckOwn.dueCount;
      }
    }
    return aggregated;
  }, []);

  const [editingDeckId, setEditingDeckId] = useState<string | null>(null);
  const [editingDeckParent, setEditingDeckParent] = useState<string | null>(null);
  const [editDeckName, setEditDeckName] = useState('');

  const [showCreateDeck, setShowCreateDeck] = useState(false);
  const [subdeckParent, setSubdeckParent] = useState<Deck | null>(null);
  const [subdeckName, setSubdeckName] = useState('');
  const [subdeckError, setSubdeckError] = useState('');
  const [actionsDeck, setActionsDeck] = useState<Deck | null>(null);
  const [actionsDeckDropUp, setActionsDeckDropUp] = useState(false);
  const [renameDeckError, setRenameDeckError] = useState('');

  const [showNoteTypes, setShowNoteTypes] = useState(false);
  const [noteTypePage, setNoteTypePage] = useState<'list' | 'create'>('list');
  const [editingNoteTypeId, setEditingNoteTypeId] = useState<string | null>(null);
  const [noteTypeActionsId, setNoteTypeActionsId] = useState<string | null>(null);
  const [noteTypeActionsDropUp, setNoteTypeActionsDropUp] = useState(false);
  const [newTypeName, setNewTypeName] = useState('');
  const [newQuestionFields, setNewQuestionFields] = useState<string[]>(['']);
  const [newAnswerFields, setNewAnswerFields] = useState<string[]>(['']);
  const [newTypeReversed, setNewTypeReversed] = useState(false);
  const [noteTypeError, setNoteTypeError] = useState('');
  const noteTypes = useLiveQuery(
    () => db.noteTypes.filter((nt) => !nt.deleted).toArray(),
    []
  );

  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  useBodyScrollLock(showCreateDeck || !!subdeckParent || showNoteTypes);

  async function handleCreateDeck(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    const name = newDeckName.trim();
    if (!name) {
      setCreateDeckError('Enter a deck name.');
      return;
    }
    if (decks?.some((d) => d.name === name)) {
      setCreateDeckError(`A deck named "${name}" already exists.`);
      return;
    }
    await createDeck(user.id, name);
    setNewDeckName('');
    setCreateDeckError('');
    setShowCreateDeck(false);
  }

  function closeCreateDeck() {
    setShowCreateDeck(false);
    setNewDeckName('');
    setCreateDeckError('');
  }

  async function handleSignOut() {
    await createClient().auth.signOut();
  }

  function startEditDeck(deck: Deck) {
    setEditingDeckId(deck.id);
    setEditingDeckParent(deckParentName(deck.name));
    setEditDeckName(deckDisplayName(deck.name));
    setRenameDeckError('');
  }

  async function handleSaveDeckName(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !editingDeckId) return;
    const name = editDeckName.trim();
    if (!name) {
      setRenameDeckError('Enter a deck name.');
      return;
    }
    const fullName = editingDeckParent ? `${editingDeckParent}::${name}` : name;
    if (decks?.some((d) => d.id !== editingDeckId && d.name === fullName)) {
      setRenameDeckError(`A deck named "${name}" already exists.`);
      return;
    }
    await editDeck(user.id, editingDeckId, { name: fullName });
    setEditingDeckId(null);
  }

  function handleDeleteDeck(deckId: string) {
    setConfirmState({
      title: 'Delete deck',
      message: 'Delete this deck, its subdecks, and all their cards? This cannot be undone.',
      onConfirm: async () => {
        if (!user) return;
        await deleteDeck(user.id, deckId);
        if (editingDeckId === deckId) setEditingDeckId(null);
        setConfirmState(null);
      },
    });
  }

  async function handleCloneDeck(deckId: string) {
    if (!user) return;
    await cloneDeck(user.id, deckId);
  }

  function handleAddSubdeck(parent: Deck) {
    setSubdeckParent(parent);
    setSubdeckName('');
    setSubdeckError('');
  }

  function closeSubdeckModal() {
    setSubdeckParent(null);
    setSubdeckName('');
    setSubdeckError('');
  }

  async function handleCreateSubdeck(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !subdeckParent) return;
    const name = subdeckName.trim();
    if (!name) {
      setSubdeckError('Enter a subdeck name.');
      return;
    }
    const fullName = `${subdeckParent.name}::${name}`;
    if (decks?.some((d) => d.name === fullName)) {
      setSubdeckError(`A subdeck named "${name}" already exists here.`);
      return;
    }
    await createDeck(user.id, fullName);
    closeSubdeckModal();
  }

  function closeNoteTypesModal() {
    setShowNoteTypes(false);
    setNoteTypePage('list');
    setEditingNoteTypeId(null);
    setNoteTypeActionsId(null);
    setNoteTypeError('');
  }

  function openCreateNoteType() {
    setEditingNoteTypeId(null);
    setNewTypeName('');
    setNewQuestionFields(['']);
    setNewAnswerFields(['']);
    setNewTypeReversed(false);
    setNoteTypeError('');
    setNoteTypePage('create');
  }

  function openEditNoteType(nt: NoteType) {
    setEditingNoteTypeId(nt.id);
    setNewTypeName(nt.name);
    setNewQuestionFields(nt.questionFields.length ? nt.questionFields : ['']);
    setNewAnswerFields(nt.answerFields.length ? nt.answerFields : ['']);
    setNewTypeReversed(nt.reversed);
    setNoteTypeError('');
    setNoteTypePage('create');
  }

  async function handleSubmitNoteType(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    const name = newTypeName.trim();
    if (!name) {
      setNoteTypeError('Enter a name.');
      return;
    }
    if (noteTypes?.some((nt) => nt.id !== editingNoteTypeId && nt.name === name)) {
      setNoteTypeError(`A note type named "${name}" already exists.`);
      return;
    }
    const questionFields = newQuestionFields.map((f) => f.trim()).filter(Boolean);
    const answerFields = newAnswerFields.map((f) => f.trim()).filter(Boolean);
    if (questionFields.length === 0) {
      setNoteTypeError('Add at least one question field.');
      return;
    }
    if (answerFields.length === 0) {
      setNoteTypeError('Add at least one answer field.');
      return;
    }
    // `fields` (the full set a note of this type holds) is just the union of
    // question/answer fields — no separate input for it, so there's no way
    // for it to drift out of sync with what's actually shown on each side.
    const fields = Array.from(new Set([...questionFields, ...answerFields]));
    if (editingNoteTypeId) {
      await editNoteType(user.id, editingNoteTypeId, {
        name,
        fields,
        questionFields,
        answerFields,
        reversed: newTypeReversed,
      });
    } else {
      await createNoteType(user.id, name, fields, questionFields, answerFields, newTypeReversed);
    }
    setNoteTypeError('');
    setNoteTypePage('list');
  }

  async function handleCloneNoteType(noteTypeId: string) {
    if (!user) return;
    await cloneNoteType(user.id, noteTypeId);
  }

  function handleDeleteNoteType(noteTypeId: string) {
    setConfirmState({
      title: 'Delete note type',
      message: 'Delete this note type? Cards using it will stop appearing.',
      onConfirm: async () => {
        if (!user) return;
        await deleteNoteType(user.id, noteTypeId);
        setConfirmState(null);
      },
    });
  }

  if (loading || !user) {
    return (
      <main className="mx-auto mb-4 max-w-md p-6 sm:mb-0">
        <p className="text-sm text-neutral-500">Loading…</p>
      </main>
    );
  }

  const deckRows = flattenDeckTree(decks ?? []);

  return (
    <main className="mx-auto mb-4 max-w-md p-6 sm:mb-0">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Flashcards</h1>
        <button
          onClick={handleSignOut}
          aria-label="Sign out"
          className="rounded-md p-2 text-neutral-400 hover:text-neutral-200"
        >
          <LogOut size={16} />
        </button>
      </div>

      <div className="mb-6">
        <ReviewHeatmap />
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Decks</h2>
        <div className="flex items-center gap-2 text-neutral-400">
          <Link
            href="/browse"
            aria-label="Browse cards"
            className="rounded-md p-2 hover:text-neutral-200"
          >
            <Search size={16} />
          </Link>
          <button
            onClick={() => setShowNoteTypes(true)}
            aria-label="Manage custom note/card types"
            className="rounded-md p-2 hover:text-neutral-200"
          >
            <LayoutTemplate size={16} />
          </button>
        </div>
      </div>

      <ul className="space-y-2">
        {deckRows.map(({ deck, depth }) =>
          editingDeckId === deck.id ? (
            <li key={deck.id} style={{ marginLeft: depth * 16 }}>
              <form onSubmit={handleSaveDeckName} className="flex gap-2">
                <div className="flex-1">
                  <input
                    value={editDeckName}
                    onChange={(e) => {
                      setEditDeckName(e.target.value);
                      setRenameDeckError('');
                    }}
                    autoFocus
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                  />
                  {renameDeckError && <p className="mt-1 text-sm text-red-400">{renameDeckError}</p>}
                </div>
                <button
                  type="submit"
                  aria-label="Save"
                  className="rounded-md p-2 text-neutral-300 hover:text-neutral-100"
                >
                  <Check size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingDeckId(null);
                    setRenameDeckError('');
                  }}
                  aria-label="Cancel"
                  className="rounded-md p-2 text-neutral-400 hover:text-neutral-200"
                >
                  <X size={16} />
                </button>
              </form>
            </li>
          ) : (
            <li
              key={deck.id}
              className="relative flex h-10 items-center gap-2"
              style={{ marginLeft: depth * 16 }}
            >
              <Link
                href={`/review/${deck.id}`}
                className="flex h-10 flex-1 items-center justify-between rounded-md border border-neutral-800 px-4 hover:bg-neutral-900"
              >
                <span>{deckDisplayName(deck.name)}</span>
                <span className="flex gap-2 text-xs font-medium">
                  <span className="text-blue-400" title={DECK_COUNT_TOOLTIPS.new}>
                    {deckCounts?.get(deck.id)?.newCount ?? 0}
                  </span>
                  <span className="text-red-400" title={DECK_COUNT_TOOLTIPS.learning}>
                    {deckCounts?.get(deck.id)?.learningCount ?? 0}
                  </span>
                  <span className="text-green-400" title={DECK_COUNT_TOOLTIPS.due}>
                    {deckCounts?.get(deck.id)?.dueCount ?? 0}
                  </span>
                </span>
              </Link>
              <button
                onClick={(e) => {
                  const opening = actionsDeck?.id !== deck.id;
                  setActionsDeck(opening ? deck : null);
                  if (opening) setActionsDeckDropUp(shouldDropUp(e.currentTarget.getBoundingClientRect()));
                }}
                aria-label="Deck actions"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:text-neutral-200"
              >
                <MoreVertical size={14} />
              </button>

              {actionsDeck?.id === deck.id && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setActionsDeck(null)} />
                  <div
                    className={`absolute right-0 z-50 flex gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-1 shadow-lg ${
                      actionsDeckDropUp ? 'bottom-full mb-1' : 'top-full mt-1'
                    }`}
                  >
                    <button
                      onClick={() => {
                        handleAddSubdeck(deck);
                        setActionsDeck(null);
                      }}
                      aria-label="Add subdeck"
                      className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
                    >
                      <FolderPlus size={16} />
                    </button>
                    {depth === 0 && (
                      <button
                        onClick={() => {
                          handleCloneDeck(deck.id);
                          setActionsDeck(null);
                        }}
                        aria-label="Duplicate deck"
                        className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
                      >
                        <Copy size={16} />
                      </button>
                    )}
                    <button
                      onClick={() => {
                        startEditDeck(deck);
                        setActionsDeck(null);
                      }}
                      aria-label="Rename deck"
                      className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      onClick={() => {
                        handleDeleteDeck(deck.id);
                        setActionsDeck(null);
                      }}
                      aria-label="Delete deck"
                      className="flex h-9 w-9 items-center justify-center rounded-md text-red-400 hover:bg-neutral-900"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </>
              )}
            </li>
          )
        )}
        {decks?.length === 0 && (
          <p className="text-sm text-neutral-500">No decks yet — add one below.</p>
        )}
      </ul>

      <button
        onClick={() => {
          setNewDeckName('');
          setCreateDeckError('');
          setShowCreateDeck(true);
        }}
        aria-label="Add deck"
        className="mt-2 flex h-10 w-full items-center justify-center rounded-md text-neutral-400 hover:text-neutral-200"
      >
        <Plus size={16} />
      </button>

      {showCreateDeck && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={closeCreateDeck}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">New deck</p>
              <button
                onClick={closeCreateDeck}
                aria-label="Close"
                className="text-neutral-400 hover:text-neutral-200"
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreateDeck} className="space-y-2">
              <input
                value={newDeckName}
                onChange={(e) => {
                  setNewDeckName(e.target.value);
                  setCreateDeckError('');
                }}
                placeholder="Deck name (or Parent::Child)"
                autoFocus
                className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
              />
              {createDeckError && <p className="text-sm text-red-400">{createDeckError}</p>}
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

      {subdeckParent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={closeSubdeckModal}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">
                New subdeck of &ldquo;{deckDisplayName(subdeckParent.name)}&rdquo;
              </p>
              <button
                onClick={closeSubdeckModal}
                aria-label="Close"
                className="text-neutral-400 hover:text-neutral-200"
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreateSubdeck} className="space-y-2">
              <input
                value={subdeckName}
                onChange={(e) => {
                  setSubdeckName(e.target.value);
                  setSubdeckError('');
                }}
                placeholder="Subdeck name"
                autoFocus
                className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
              />
              {subdeckError && <p className="text-sm text-red-400">{subdeckError}</p>}
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

      {showNoteTypes && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={closeNoteTypesModal}
        >
          <div
            className="max-h-[85vh] w-full max-w-sm overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            {noteTypePage === 'list' ? (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-sm font-medium">Custom note/card types</p>
                  <button
                    onClick={closeNoteTypesModal}
                    aria-label="Close"
                    className="text-neutral-400 hover:text-neutral-200"
                  >
                    <X size={16} />
                  </button>
                </div>

                <ul className="space-y-2">
                  {noteTypes?.map((nt) => (
                    <li key={nt.id} className="relative flex h-10 items-center gap-2">
                      <div className="flex h-10 flex-1 items-center rounded-md border border-neutral-800 px-4 text-sm">
                        <span className="truncate">{nt.name}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          const opening = noteTypeActionsId !== nt.id;
                          setNoteTypeActionsId(opening ? nt.id : null);
                          if (opening) setNoteTypeActionsDropUp(shouldDropUp(e.currentTarget.getBoundingClientRect()));
                        }}
                        aria-label="Custom note/card type actions"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:text-neutral-200"
                      >
                        <MoreVertical size={14} />
                      </button>

                      {noteTypeActionsId === nt.id && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setNoteTypeActionsId(null)} />
                          <div
                            className={`absolute right-0 z-50 flex gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-1 shadow-lg ${
                              noteTypeActionsDropUp ? 'bottom-full mb-1' : 'top-full mt-1'
                            }`}
                          >
                            <button
                              onClick={() => {
                                openEditNoteType(nt);
                                setNoteTypeActionsId(null);
                              }}
                              aria-label="Edit custom note/card type"
                              className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              onClick={() => {
                                handleCloneNoteType(nt.id);
                                setNoteTypeActionsId(null);
                              }}
                              aria-label="Duplicate custom note/card type"
                              className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
                            >
                              <Copy size={16} />
                            </button>
                            <button
                              onClick={() => {
                                handleDeleteNoteType(nt.id);
                                setNoteTypeActionsId(null);
                              }}
                              aria-label="Delete custom note/card type"
                              className="flex h-9 w-9 items-center justify-center rounded-md text-red-400 hover:bg-neutral-900"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                  {(!noteTypes || noteTypes.length === 0) && (
                    <p className="text-sm text-neutral-500">No custom note/card types yet.</p>
                  )}
                </ul>

                <button
                  onClick={openCreateNoteType}
                  aria-label="New custom note/card type"
                  className="mt-2 flex h-10 w-full items-center justify-center rounded-md text-neutral-400 hover:text-neutral-200"
                >
                  <Plus size={16} />
                </button>
              </>
            ) : (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <button
                    onClick={() => {
                      setNoteTypeError('');
                      setNoteTypePage('list');
                    }}
                    aria-label="Back"
                    className="text-neutral-400 hover:text-neutral-200"
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <p className="text-sm font-medium">
                    {editingNoteTypeId ? 'Edit custom note/card type' : 'New custom note/card type'}
                  </p>
                </div>

                <form onSubmit={handleSubmitNoteType} className="space-y-2">
                  <input
                    value={newTypeName}
                    onChange={(e) => {
                      setNewTypeName(e.target.value);
                      setNoteTypeError('');
                    }}
                    placeholder="Name (e.g. Vocabulary)"
                    autoFocus
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                  />
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-neutral-400">Question fields</p>
                    {newQuestionFields.map((field, i) => (
                      <div key={i} className="flex gap-2">
                        <input
                          value={field}
                          onChange={(e) =>
                            setNewQuestionFields((fs) =>
                              fs.map((f, fi) => (fi === i ? e.target.value : f))
                            )
                          }
                          placeholder="Field name (e.g. Word)"
                          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                        />
                        {newQuestionFields.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setNewQuestionFields((fs) => fs.filter((_, fi) => fi !== i))
                            }
                            aria-label="Remove field"
                            className="shrink-0 text-neutral-500 hover:text-neutral-300"
                          >
                            <X size={16} />
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setNewQuestionFields((fs) => [...fs, ''])}
                      aria-label="Add question field"
                      className="flex h-8 w-full items-center justify-center rounded-md text-neutral-400 hover:text-neutral-200"
                    >
                      <Plus size={14} />
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-neutral-400">Answer fields</p>
                    {newAnswerFields.map((field, i) => (
                      <div key={i} className="flex gap-2">
                        <input
                          value={field}
                          onChange={(e) =>
                            setNewAnswerFields((fs) =>
                              fs.map((f, fi) => (fi === i ? e.target.value : f))
                            )
                          }
                          placeholder="Field name (e.g. Meaning)"
                          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                        />
                        {newAnswerFields.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setNewAnswerFields((fs) => fs.filter((_, fi) => fi !== i))
                            }
                            aria-label="Remove field"
                            className="shrink-0 text-neutral-500 hover:text-neutral-300"
                          >
                            <X size={16} />
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setNewAnswerFields((fs) => [...fs, ''])}
                      aria-label="Add answer field"
                      className="flex h-8 w-full items-center justify-center rounded-md text-neutral-400 hover:text-neutral-200"
                    >
                      <Plus size={14} />
                    </button>
                  </div>

                  <label className="flex items-center gap-2 text-xs text-neutral-400">
                    <input
                      type="checkbox"
                      checked={newTypeReversed}
                      onChange={(e) => setNewTypeReversed(e.target.checked)}
                      className="accent-neutral-100"
                    />
                    Allow reversed cards (lets you opt in per note when creating a card)
                  </label>

                  {noteTypeError && <p className="text-sm text-red-400">{noteTypeError}</p>}

                  <button
                    type="submit"
                    className="w-full rounded-md bg-neutral-100 py-2 text-sm font-medium text-neutral-900"
                  >
                    {editingNoteTypeId ? 'Save' : 'Create'}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      )}

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
