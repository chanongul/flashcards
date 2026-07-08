"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  LogOut,
  Pencil,
  Trash2,
  Check,
  X,
  Search,
  FolderPlus,
  LayoutTemplate,
  FilePlus,
  Plus,
  MoreVertical,
  Copy,
  ArrowLeft,
  GripVertical,
} from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  db,
  type Deck,
  type NoteType,
  type FieldTypeConfig,
  type TextFormat,
} from "@/lib/db";
import {
  FieldTypeConfigToggle,
  readTextFormat,
  buildFormattedText,
  NORMAL_TEXT_FORMAT,
} from "@/components/MediaFieldInput";
import { TagsInput } from "@/components/TagsInput";
import { RichTextInput } from "@/components/RichTextInput";
import { stripHtml } from "@/lib/sanitize";
import { useLoading, useLoadingWhen } from "@/components/GlobalLoading";
import {
  createDeck,
  editDeck,
  deleteDeck,
  cloneDeck,
  createNoteType,
  editNoteType,
  deleteNoteType,
  cloneNoteType,
  resetAllData,
  createCard,
} from "@/lib/actions";
import { useUser } from "@/lib/useUser";
import { useBodyScrollLock } from "@/lib/useBodyScrollLock";
import { createClient } from "@/utils/supabase/client";
import { sync } from "@/lib/sync";
import { syncPendingMedia } from "@/lib/mediaSync";
import {
  countCardsByState,
  DECK_COUNT_TOOLTIPS,
  type DeckCounts,
} from "@/lib/stats";
import {
  deckDisplayName,
  deckParentName,
  ancestorNames,
  flattenDeckTree,
  deckDepth,
  MAX_DECK_DEPTH,
} from "@/lib/decks";
import { ReviewHeatmap } from "@/components/ReviewHeatmap";
import { TodayStatusSummary } from "@/components/TodayStatusSummary";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Checkbox } from "@/components/Checkbox";
import { shouldDropUp } from "@/lib/dropdownMenu";
import { CardForm } from "@/components/CardForm";

// One row in the note-type editor's question/answer field lists — a name
// plus its declared type (or 'dynamic', deferring the choice to each note).
// `choices` only matters when type === 'choice': the shared option list
// every note of this type picks from for this field.
interface FieldRow {
  name: string;
  type: FieldTypeConfig;
  choices: string[];
  // Starter formatting for this field, captured from whatever rich text
  // effects were toggled on its name (only meaningful — and only editable —
  // when type is 'richtext' or 'choice'). See NoteType.fieldTemplates.
  format: TextFormat;
}

export default function HomePage() {
  const { user, loading } = useUser();
  const { withLoading } = useLoading();
  const decks = useLiveQuery(
    () => db.decks.filter((d) => !d.deleted).toArray(),
    [],
  );
  const [titleSkewed, setTitleSkewed] = useState(false);
  // Feature-detecting "real mouse vs touch" via matchMedia turned out
  // unreliable in both directions — (hover: hover) alone matched on some
  // touch browsers, and adding "and (pointer: fine)" then wrongly excluded
  // some real desktop trackpads/mice. Tracking the actual most-recent
  // interaction instead sidesteps all of that: a touch always fires before
  // any synthetic mouseenter/mouseleave a mobile browser adds for click
  // compatibility, so this flag suppresses exactly those and only those.
  const justTouchedRef = useRef(false);
  const touchFlagTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTitleHoverStart = () => {
    if (justTouchedRef.current) return;
    setTitleSkewed(true);
  };

  const handleTitleHoverEnd = () => {
    if (justTouchedRef.current) return;
    setTitleSkewed(false);
    cancelPressHoldTimers();
  };

  // Skewed for exactly as long as the finger is down — no timer, just
  // start on touchstart and end on touchend/touchcancel (a call coming in
  // mid-touch, etc., still counts as "no longer touching").
  const handleTitleTouchStart = () => {
    justTouchedRef.current = true;
    if (touchFlagTimeout.current) clearTimeout(touchFlagTimeout.current);
    touchFlagTimeout.current = setTimeout(() => {
      justTouchedRef.current = false;
    }, 500);
    setTitleSkewed(true);
    startPressHoldTimers();
  };

  const handleTitleTouchEnd = () => {
    setTitleSkewed(false);
    endPressHoldTimers();
  };

  // Two hidden gestures layered on the same press, mutually exclusive by
  // duration: held 1–5s then released → reload the page. Held past 5s
  // → toggle the reset-all-data button below (fires automatically while
  // still held, not on release) and does NOT also reload — that would
  // instantly wipe out the very state it just revealed. A plain elapsed-
  // time check at release time (rather than two independent timers/flags)
  // is what makes those mutually exclusive without extra bookkeeping.
  const REFRESH_HOLD_MS = 1_000;
  const RESET_HOLD_MS = 5_000;
  const [showResetButton, setShowResetButton] = useState(false);
  const resetHoldTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartRef = useRef<number | null>(null);

  function startPressHoldTimers() {
    pressStartRef.current = Date.now();
    if (resetHoldTimeout.current) clearTimeout(resetHoldTimeout.current);
    resetHoldTimeout.current = setTimeout(() => {
      setShowResetButton((v) => !v);
    }, RESET_HOLD_MS);
  }

  function cancelPressHoldTimers() {
    if (resetHoldTimeout.current) clearTimeout(resetHoldTimeout.current);
    resetHoldTimeout.current = null;
    pressStartRef.current = null;
  }

  function endPressHoldTimers() {
    const start = pressStartRef.current;
    cancelPressHoldTimers();
    if (start === null) return;
    const heldMs = Date.now() - start;
    if (heldMs >= REFRESH_HOLD_MS && heldMs < RESET_HOLD_MS) {
      window.location.reload();
    }
  }

  // The title doubles as a manual sync trigger — same push-then-pull the
  // background SyncManager already does on its own interval/focus ticks,
  // just on demand for "I want this to happen right now" (e.g. right after
  // making a change on another device).
  async function handleTitleClick() {
    if (!user) return;
    await withLoading(async () => {
      await sync(user.id);
      await syncPendingMedia(user.id);
    });
  }
  const [newDeckName, setNewDeckName] = useState("");
  const [createDeckError, setCreateDeckError] = useState("");

  const deckCounts = useLiveQuery(async () => {
    const [allDecks, cards] = await Promise.all([
      db.decks.filter((d) => !d.deleted).toArray(),
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
  const [editingDeckParent, setEditingDeckParent] = useState<string | null>(
    null,
  );
  const [editDeckName, setEditDeckName] = useState("");

  const [showCreateDeck, setShowCreateDeck] = useState(false);
  const [subdeckParent, setSubdeckParent] = useState<Deck | null>(null);
  const [subdeckName, setSubdeckName] = useState("");
  const [subdeckError, setSubdeckError] = useState("");
  const [actionsDeck, setActionsDeck] = useState<Deck | null>(null);
  const [actionsDeckDropUp, setActionsDeckDropUp] = useState(false);
  const [renameDeckError, setRenameDeckError] = useState("");

  // Which decks are currently folded (their subdecks hidden) — press-and-hold
  // on the ellipsis button of a deck with children toggles it. Persisted to
  // localStorage so the fold state survives page refreshes.
  const DECK_COLLAPSED_KEY = "flashcards:deck-collapsed";
  const [collapsedDeckIds, setCollapsedDeckIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(DECK_COLLAPSED_KEY);
      if (stored) return new Set(JSON.parse(stored) as string[]);
    } catch {}
    return new Set();
  });
  const FOLD_HOLD_MS = 500;
  const foldHoldTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set true the instant the hold timer fires, so the click that follows the
  // release (mouseup/touchend always synthesizes one) can be swallowed
  // instead of navigating — same "did a hold already happen" pattern as
  // press-hold's own reset-button gesture below, just per-deck instead of a
  // single shared target.
  const foldTriggeredRef = useRef(false);
  // Timestamp of the last fold/unfold. Used as a fallback gate in onClick:
  // on mobile, when unfolding adds new DOM rows the browser fires a synthetic
  // mousedown before the click, which calls startFoldHold and resets
  // foldTriggeredRef to false before onClick runs — so foldTriggeredRef alone
  // can't suppress the menu. The timestamp check is immune to this.
  const lastFoldTimestampRef = useRef(0);

  function toggleDeckFold(deckId: string) {
    setCollapsedDeckIds((prev) => {
      const next = new Set(prev);
      if (next.has(deckId)) next.delete(deckId);
      else next.add(deckId);
      return next;
    });
  }

  // Sync collapsed state to localStorage whenever it changes.
  useEffect(() => {
    try {
      localStorage.setItem(
        DECK_COLLAPSED_KEY,
        JSON.stringify([...collapsedDeckIds]),
      );
    } catch {}
  }, [collapsedDeckIds]);

  function startFoldHold(deckId: string) {
    foldTriggeredRef.current = false;
    if (foldHoldTimeout.current) clearTimeout(foldHoldTimeout.current);
    foldHoldTimeout.current = setTimeout(() => {
      foldTriggeredRef.current = true;
      lastFoldTimestampRef.current = Date.now();
      toggleDeckFold(deckId);
    }, FOLD_HOLD_MS);
  }

  function cancelFoldHold() {
    if (foldHoldTimeout.current) clearTimeout(foldHoldTimeout.current);
    foldHoldTimeout.current = null;
  }

  // Swallows the click a long-press's release always synthesizes — without
  // this, holding a deck to fold it would also navigate into the deck the
  // instant the finger/mouse lifts.
  function handleDeckLinkClick(e: React.MouseEvent) {
    if (foldTriggeredRef.current) {
      e.preventDefault();
      foldTriggeredRef.current = false;
    }
  }

  // Holding the "Decks" heading (a much longer hold than a single deck row's,
  // since this is a broader/harder-to-undo-by-accident action) toggles every
  // foldable deck at once — see toggleAllDeckFold below, defined after
  // `decks` is available; referencing it here works because function
  // declarations are hoisted for the whole component body.
  const ALL_FOLD_HOLD_MS = 1000;
  const allFoldHoldTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  function startAllFoldHold() {
    if (allFoldHoldTimeout.current) clearTimeout(allFoldHoldTimeout.current);
    allFoldHoldTimeout.current = setTimeout(() => {
      toggleAllDeckFold();
    }, ALL_FOLD_HOLD_MS);
  }

  function cancelAllFoldHold() {
    if (allFoldHoldTimeout.current) clearTimeout(allFoldHoldTimeout.current);
    allFoldHoldTimeout.current = null;
  }

  const [showNoteTypes, setShowNoteTypes] = useState(false);
  const [noteTypePage, setNoteTypePage] = useState<"list" | "create">("list");
  const [editingNoteTypeId, setEditingNoteTypeId] = useState<string | null>(
    null,
  );
  const [noteTypeActionsId, setNoteTypeActionsId] = useState<string | null>(
    null,
  );
  const [noteTypeActionsDropUp, setNoteTypeActionsDropUp] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [newQuestionFields, setNewQuestionFields] = useState<FieldRow[]>([
    { name: "", type: "richtext", choices: [], format: NORMAL_TEXT_FORMAT },
  ]);
  const [newAnswerFields, setNewAnswerFields] = useState<FieldRow[]>([
    { name: "", type: "richtext", choices: [], format: NORMAL_TEXT_FORMAT },
  ]);
  const [newTypeReversed, setNewTypeReversed] = useState(false);
  const [noteTypeError, setNoteTypeError] = useState("");
  // Drag-reorder tracking: dragIndex stored in a ref (no re-render needed),
  // dragOverIndex stored in state so the drop-target highlight updates live
  // as the user hovers over different items.
  const dragIndexQRef = useRef<number | null>(null);
  const [dragOverIndexQ, setDragOverIndexQ] = useState<number | null>(null);
  const dragIndexARef = useRef<number | null>(null);
  const [dragOverIndexA, setDragOverIndexA] = useState<number | null>(null);
  // Set to true by the grip handle's onPointerDown so onDragStart knows the
  // drag was legitimately initiated from the handle and not from an accidental
  // drag on the input field or other row content.
  const dragHandleActivatedQRef = useRef(false);
  const dragHandleActivatedARef = useRef(false);
  // Swaps items at indices `a` and `b` in a copy of `arr`.
  function swapItems<T>(arr: T[], a: number, b: number): T[] {
    if (a === b) return arr;
    const next = [...arr];
    [next[a], next[b]] = [next[b], next[a]];
    return next;
  }

  const noteTypes = useLiveQuery(
    () => db.noteTypes.filter((nt) => !nt.deleted).toArray(),
    [],
  );

  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState("");
  const [actionsAddCardDeck, setActionsAddCardDeck] = useState<Deck | null>(
    null,
  );

  useBodyScrollLock(
    showCreateDeck ||
      !!subdeckParent ||
      showNoteTypes ||
      showResetConfirm ||
      !!actionsAddCardDeck,
  );

  async function handleResetAllData() {
    if (!user || resetConfirmText !== "RESET") return;
    await withLoading(() => resetAllData(user.id));
    setShowResetConfirm(false);
    setResetConfirmText("");
  }

  async function handleCreateDeck(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    // Users type "Parent>Child" for subdecks; decks are stored with Anki's
    // "::" delimiter internally (which all the hierarchy logic relies on),
    // so translate the friendlier ">" separator to "::" before creating.
    const name = newDeckName
      .split(">")
      .map((part) => part.trim())
      .filter(Boolean)
      .join("::");
    if (!name) {
      setCreateDeckError("Enter a deck name.");
      return;
    }
    if (decks?.some((d) => d.name === name)) {
      setCreateDeckError(
        `A deck named "${name.replaceAll("::", ">")}" already exists.`,
      );
      return;
    }
    if (deckDepth(name) > MAX_DECK_DEPTH) {
      setCreateDeckError(`Decks can only nest ${MAX_DECK_DEPTH} levels deep.`);
      return;
    }
    await withLoading(() => createDeck(user.id, name));
    setNewDeckName("");
    setCreateDeckError("");
    setShowCreateDeck(false);
  }

  function closeCreateDeck() {
    setShowCreateDeck(false);
    setNewDeckName("");
    setCreateDeckError("");
  }

  async function handleSignOut() {
    await createClient().auth.signOut();
  }

  function startEditDeck(deck: Deck) {
    setEditingDeckId(deck.id);
    setEditingDeckParent(deckParentName(deck.name));
    setEditDeckName(deckDisplayName(deck.name));
    setRenameDeckError("");
  }

  async function handleSaveDeckName(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !editingDeckId) return;
    const name = editDeckName.trim();
    if (!name) {
      setRenameDeckError("Enter a deck name.");
      return;
    }
    const fullName = editingDeckParent ? `${editingDeckParent}::${name}` : name;
    if (decks?.some((d) => d.id !== editingDeckId && d.name === fullName)) {
      setRenameDeckError(`A deck named "${name}" already exists.`);
      return;
    }
    await withLoading(() =>
      editDeck(user.id, editingDeckId, { name: fullName }),
    );
    setEditingDeckId(null);
  }

  function handleDeleteDeck(deck: Deck) {
    const kind = deckParentName(deck.name) !== null ? "subdeck" : "deck";
    setConfirmState({
      title: `Delete ${kind}`,
      message: `Delete this ${kind}, its subdecks, and all their cards? This cannot be undone.`,
      onConfirm: async () => {
        if (!user) return;
        await deleteDeck(user.id, deck.id);
        if (editingDeckId === deck.id) setEditingDeckId(null);
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
    setSubdeckName("");
    setSubdeckError("");
  }

  function closeSubdeckModal() {
    setSubdeckParent(null);
    setSubdeckName("");
    setSubdeckError("");
  }

  async function handleCreateSubdeck(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !subdeckParent) return;
    const name = subdeckName.trim();
    if (!name) {
      setSubdeckError("Enter a subdeck name.");
      return;
    }
    const fullName = `${subdeckParent.name}::${name}`;
    if (decks?.some((d) => d.name === fullName)) {
      setSubdeckError(`A subdeck named "${name}" already exists here.`);
      return;
    }
    if (deckDepth(fullName) > MAX_DECK_DEPTH) {
      setSubdeckError(`Decks can only nest ${MAX_DECK_DEPTH} levels deep.`);
      return;
    }
    await withLoading(() => createDeck(user.id, fullName));
    closeSubdeckModal();
  }

  function closeNoteTypesModal() {
    setShowNoteTypes(false);
    setNoteTypePage("list");
    setEditingNoteTypeId(null);
    setNoteTypeActionsId(null);
    setNoteTypeError("");
  }

  function openCreateNoteType() {
    setEditingNoteTypeId(null);
    setNewTypeName("");
    setNewQuestionFields([
      { name: "", type: "richtext", choices: [], format: NORMAL_TEXT_FORMAT },
    ]);
    setNewAnswerFields([
      { name: "", type: "richtext", choices: [], format: NORMAL_TEXT_FORMAT },
    ]);
    setNewTypeReversed(false);
    setNoteTypeError("");
    setNoteTypePage("create");
  }

  function openEditNoteType(nt: NoteType) {
    setEditingNoteTypeId(nt.id);
    setNewTypeName(nt.name);
    const toRow = (name: string): FieldRow => ({
      name,
      type: nt.fieldTypes?.[name] ?? "richtext",
      choices: nt.fieldChoices?.[name] ?? [],
      format: nt.fieldTemplates?.[name] ?? NORMAL_TEXT_FORMAT,
    });
    setNewQuestionFields(
      nt.questionFields.length
        ? nt.questionFields.map(toRow)
        : [
            {
              name: "",
              type: "richtext",
              choices: [],
              format: NORMAL_TEXT_FORMAT,
            },
          ],
    );
    setNewAnswerFields(
      nt.answerFields.length
        ? nt.answerFields.map(toRow)
        : [
            {
              name: "",
              type: "richtext",
              choices: [],
              format: NORMAL_TEXT_FORMAT,
            },
          ],
    );
    setNewTypeReversed(nt.reversed);
    setNoteTypeError("");
    setNoteTypePage("create");
  }

  async function handleSubmitNoteType(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    const name = newTypeName.trim();
    if (!name) {
      setNoteTypeError("Enter a name.");
      return;
    }
    if (
      noteTypes?.some((nt) => nt.id !== editingNoteTypeId && nt.name === name)
    ) {
      setNoteTypeError(`A note type named "${name}" already exists.`);
      return;
    }
    const questionRows = newQuestionFields
      .map((f) => ({ ...f, name: f.name.trim() }))
      .filter((f) => f.name);
    const answerRows = newAnswerFields
      .map((f) => ({ ...f, name: f.name.trim() }))
      .filter((f) => f.name);
    if (questionRows.length === 0) {
      setNoteTypeError("Add at least one question field.");
      return;
    }
    if (answerRows.length === 0) {
      setNoteTypeError("Add at least one answer field.");
      return;
    }
    const emptyChoiceField = [...questionRows, ...answerRows].find(
      (f) =>
        f.type === "choice" && f.choices.filter((c) => c.trim()).length === 0,
    );
    if (emptyChoiceField) {
      setNoteTypeError(
        `Add at least one option for "${emptyChoiceField.name}".`,
      );
      return;
    }
    const questionFields = questionRows.map((f) => f.name);
    const answerFields = answerRows.map((f) => f.name);
    // `fields` (the full set a note of this type holds) is just the union of
    // question/answer fields — no separate input for it, so there's no way
    // for it to drift out of sync with what's actually shown on each side.
    const fields = Array.from(new Set([...questionFields, ...answerFields]));
    const fieldTypes = Object.fromEntries(
      [...questionRows, ...answerRows].map((f) => [f.name, f.type]),
    );
    const fieldChoices = Object.fromEntries(
      [...questionRows, ...answerRows]
        .filter((f) => f.type === "choice")
        .map((f) => [f.name, f.choices.map((c) => c.trim()).filter(Boolean)]),
    );
    const fieldTemplates = Object.fromEntries(
      [...questionRows, ...answerRows]
        .filter((f) => f.type === "richtext" || f.type === "choice")
        .map((f) => [f.name, f.format]),
    );
    if (editingNoteTypeId) {
      await withLoading(() =>
        editNoteType(user.id, editingNoteTypeId, {
          name,
          fields,
          questionFields,
          answerFields,
          fieldTypes,
          fieldChoices,
          fieldTemplates,
          reversed: newTypeReversed,
        }),
      );
    } else {
      await withLoading(() =>
        createNoteType(
          user.id,
          name,
          fields,
          questionFields,
          answerFields,
          fieldTypes,
          newTypeReversed,
          fieldChoices,
          fieldTemplates,
        ),
      );
    }
    setNoteTypeError("");
    setNoteTypePage("list");
  }

  async function handleCloneNoteType(noteTypeId: string) {
    if (!user) return;
    await cloneNoteType(user.id, noteTypeId);
  }

  function handleDeleteNoteType(noteTypeId: string) {
    setConfirmState({
      title: "Delete note type",
      message: "Delete this note type? Cards using it will stop appearing.",
      onConfirm: async () => {
        if (!user) return;
        await deleteNoteType(user.id, noteTypeId);
        setConfirmState(null);
      },
    });
  }

  useLoadingWhen(loading || !user);

  if (loading || !user) {
    return null;
  }

  const deckRows = flattenDeckTree(decks ?? []);

  // A deck "has children" if some other deck's name is "thisDeck::...".
  const deckNamesWithChildren = new Set(
    (decks ?? [])
      .map((d) => deckParentName(d.name))
      .filter((name): name is string => name !== null),
  );
  const foldableDeckIds = (decks ?? [])
    .filter((d) => deckNamesWithChildren.has(d.name))
    .map((d) => d.id);

  // Holding the "Decks" heading toggles every foldable deck at once — if
  // everything's already folded, unfold all; otherwise fold all (matches a
  // typical "collapse all" control's behavior, and means the gesture is
  // idempotent regardless of whatever mixed state individual holds left
  // things in).
  function toggleAllDeckFold() {
    setCollapsedDeckIds((prev) => {
      const allFolded =
        foldableDeckIds.length > 0 &&
        foldableDeckIds.every((id) => prev.has(id));
      return allFolded ? new Set() : new Set(foldableDeckIds);
    });
  }

  // flattenDeckTree already puts a deck's descendants immediately after it
  // (pre-order), so hiding a collapsed deck's subtree is one linear pass:
  // once we hit a collapsed deck, skip every following row deeper than it,
  // stopping the skip as soon as depth returns to that level or shallower.
  const visibleDeckRows: typeof deckRows = [];
  let hideBelowDepth: number | null = null;
  for (const row of deckRows) {
    if (hideBelowDepth !== null) {
      if (row.depth > hideBelowDepth) continue;
      hideBelowDepth = null;
    }
    visibleDeckRows.push(row);
    if (
      collapsedDeckIds.has(row.deck.id) &&
      deckNamesWithChildren.has(row.deck.name)
    ) {
      hideBelowDepth = row.depth;
    }
  }

  return (
    <main className="mx-auto mb-4 max-w-md p-6 pt-2 md:pt-6 sm:mb-0">
      <div className="mb-6 flex items-center justify-between">
        <h1
          className={`relative inline-block cursor-pointer text-3xl font-black transition-all duration-200 ${titleSkewed ? "translate-x-[12%] scale-[115%] -skew-x-[15deg]" : ""} ${showResetButton ? "text-orange-600" : ""}`}
          onMouseEnter={handleTitleHoverStart}
          onMouseLeave={handleTitleHoverEnd}
          onMouseDown={startPressHoldTimers}
          onMouseUp={endPressHoldTimers}
          onTouchStart={handleTitleTouchStart}
          onTouchEnd={handleTitleTouchEnd}
          onTouchCancel={handleTitleTouchEnd}
          onClick={handleTitleClick}
          role="button"
          aria-label="Sync now"
          title="Sync now"
        >
          Flashcards
          <span
            className={`absolute bottom-0 left-0 h-0.5 bg-current transition-[width] duration-700 ease-[cubic-bezier(0.1,1.1,0.025,1)] ${titleSkewed ? "w-full" : "w-0"}`}
          />
        </h1>
        <button
          onClick={handleSignOut}
          aria-label="Sign out"
          className="rounded-md text-neutral-400 hover:text-neutral-200"
        >
          <LogOut size={16} />
        </button>
      </div>

      <div className="mb-6">
        <TodayStatusSummary />
      </div>

      <div className="mb-6">
        <ReviewHeatmap />
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h2
          className="text-xl cursor-pointer font-bold"
          onMouseDown={startAllFoldHold}
          onMouseUp={cancelAllFoldHold}
          onMouseLeave={cancelAllFoldHold}
          onTouchStart={startAllFoldHold}
          onTouchEnd={cancelAllFoldHold}
          onTouchCancel={cancelAllFoldHold}
          onContextMenu={(e) => e.preventDefault()}
        >
          Decks
        </h2>
        <div className="flex items-center gap-2 text-neutral-400">
          <Link
            href="/browse"
            aria-label="Browse cards"
            className="flex h-10 w-10 items-center justify-center rounded-md border border-neutral-800 hover:text-neutral-200"
          >
            <Search size={16} />
          </Link>
          <button
            onClick={() => setShowNoteTypes(true)}
            aria-label="Manage custom card types"
            className="flex h-10 w-10 items-center justify-center rounded-md border border-neutral-800 hover:text-neutral-200"
          >
            <LayoutTemplate size={16} />
          </button>
        </div>
      </div>

      <ul className="space-y-2">
        {visibleDeckRows.map(({ deck, depth }) => {
          const hasChildren = deckNamesWithChildren.has(deck.name);
          const isFolded = hasChildren && collapsedDeckIds.has(deck.id);
          return editingDeckId === deck.id ? (
            <li key={deck.id} style={{ marginLeft: depth * 16 }}>
              <form onSubmit={handleSaveDeckName} className="flex gap-2">
                <div className="flex-1">
                  <input
                    value={editDeckName}
                    onChange={(e) => {
                      setEditDeckName(e.target.value);
                      setRenameDeckError("");
                    }}
                    autoFocus
                    className="h-10 w-full rounded-md border border-neutral-800 bg-neutral-900 px-4"
                  />
                  {renameDeckError && (
                    <p className="mt-1 text-sm text-red-400">
                      {renameDeckError}
                    </p>
                  )}
                </div>
                <button
                  type="submit"
                  aria-label="Save"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-neutral-800 text-neutral-300 hover:text-neutral-100"
                >
                  <Check size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingDeckId(null);
                    setRenameDeckError("");
                  }}
                  aria-label="Cancel"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-neutral-800 text-neutral-400 hover:text-neutral-200"
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
                onClick={handleDeckLinkClick}
                onContextMenu={(e) => e.preventDefault()}
                className={`flex h-10 flex-1 items-center justify-between rounded-md border border-neutral-800 px-4 hover:bg-neutral-900 ${
                  isFolded ? "bg-white/[0.025]" : ""
                }`}
              >
                <span>{deckDisplayName(deck.name)}</span>
                <span className="flex gap-2 text-xs font-medium">
                  <span
                    className="text-sky-400"
                    title={DECK_COUNT_TOOLTIPS.new}
                  >
                    {deckCounts?.get(deck.id)?.newCount ?? 0}
                  </span>
                  <span
                    className="text-orange-600"
                    title={DECK_COUNT_TOOLTIPS.learning}
                  >
                    {deckCounts?.get(deck.id)?.learningCount ?? 0}
                  </span>
                  <span
                    className="text-olive-300"
                    title={DECK_COUNT_TOOLTIPS.due}
                  >
                    {deckCounts?.get(deck.id)?.dueCount ?? 0}
                  </span>
                </span>
              </Link>
              <button
                onClick={(e) => {
                  if (
                    foldTriggeredRef.current ||
                    Date.now() - lastFoldTimestampRef.current < 600
                  ) {
                    foldTriggeredRef.current = false;
                    return;
                  }
                  const opening = actionsDeck?.id !== deck.id;
                  setActionsDeck(opening ? deck : null);
                  if (opening)
                    setActionsDeckDropUp(
                      shouldDropUp(e.currentTarget.getBoundingClientRect()),
                    );
                }}
                onMouseDown={() => hasChildren && startFoldHold(deck.id)}
                onMouseUp={cancelFoldHold}
                onMouseLeave={cancelFoldHold}
                onTouchStart={() => hasChildren && startFoldHold(deck.id)}
                onTouchEnd={cancelFoldHold}
                onTouchCancel={cancelFoldHold}
                onContextMenu={(e) => e.preventDefault()}
                aria-label="Deck actions"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-neutral-800 text-neutral-400 hover:text-neutral-200"
              >
                <MoreVertical size={14} />
              </button>

              {actionsDeck?.id === deck.id && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setActionsDeck(null)}
                  />
                  <div
                    className={`absolute right-0 z-50 flex gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-1 shadow-lg ${
                      actionsDeckDropUp ? "bottom-full mb-1" : "top-full mt-1"
                    }`}
                  >
                    <button
                      onClick={() => {
                        setActionsAddCardDeck(deck);
                        setActionsDeck(null);
                      }}
                      aria-label="Add card"
                      className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
                    >
                      <FilePlus size={16} />
                    </button>
                    {deckDepth(deck.name) < MAX_DECK_DEPTH && (
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
                    )}
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
                        handleDeleteDeck(deck);
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
          );
        })}
        {decks?.length === 0 && (
          <p className="text-sm text-neutral-500">
            No decks yet — add one below.
          </p>
        )}
      </ul>

      <button
        onClick={() => {
          setNewDeckName("");
          setCreateDeckError("");
          setShowCreateDeck(true);
        }}
        aria-label="Add deck"
        className="mt-2 flex h-10 w-full items-center justify-center rounded-md border border-neutral-800 text-neutral-400 hover:text-neutral-200"
      >
        <Plus size={16} />
      </button>

      {showResetButton && (
        <button
          onClick={() => {
            setResetConfirmText("");
            setShowResetConfirm(true);
          }}
          className="mt-6 flex w-full justify-center text-xs text-neutral-600 hover:text-red-400"
        >
          Reset all data
        </button>
      )}

      {showCreateDeck && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={closeCreateDeck}
        >
          <div
            className="max-h-[85vh] w-full max-w-sm overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-4"
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
                  setCreateDeckError("");
                }}
                placeholder="Deck name (or Parent>Child)"
                autoFocus
                className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
              />
              {createDeckError && (
                <p className="text-sm text-red-400">{createDeckError}</p>
              )}
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
            className="max-h-[85vh] w-full max-w-sm overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">
                New subdeck of &ldquo;{deckDisplayName(subdeckParent.name)}
                &rdquo;
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
                  setSubdeckError("");
                }}
                placeholder="Subdeck name"
                autoFocus
                className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
              />
              {subdeckError && (
                <p className="text-sm text-red-400">{subdeckError}</p>
              )}
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
            {noteTypePage === "list" ? (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-sm font-medium">Custom card types</p>
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
                    <li
                      key={nt.id}
                      className="relative flex h-10 items-center gap-2"
                    >
                      <div className="flex h-10 flex-1 items-center rounded-md border border-neutral-800 px-4 text-sm">
                        <span className="truncate">{nt.name}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          const opening = noteTypeActionsId !== nt.id;
                          setNoteTypeActionsId(opening ? nt.id : null);
                          if (opening)
                            setNoteTypeActionsDropUp(
                              shouldDropUp(
                                e.currentTarget.getBoundingClientRect(),
                              ),
                            );
                        }}
                        aria-label="Custom card type actions"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-neutral-800 text-neutral-400 hover:text-neutral-200"
                      >
                        <MoreVertical size={14} />
                      </button>

                      {noteTypeActionsId === nt.id && (
                        <>
                          <div
                            className="fixed inset-0 z-40"
                            onClick={() => setNoteTypeActionsId(null)}
                          />
                          <div
                            className={`absolute right-0 z-50 flex gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-1 shadow-lg ${
                              noteTypeActionsDropUp
                                ? "bottom-full mb-1"
                                : "top-full mt-1"
                            }`}
                          >
                            <button
                              onClick={() => {
                                openEditNoteType(nt);
                                setNoteTypeActionsId(null);
                              }}
                              aria-label="Edit custom card type"
                              className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              onClick={() => {
                                handleCloneNoteType(nt.id);
                                setNoteTypeActionsId(null);
                              }}
                              aria-label="Duplicate custom card type"
                              className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900"
                            >
                              <Copy size={16} />
                            </button>
                            <button
                              onClick={() => {
                                handleDeleteNoteType(nt.id);
                                setNoteTypeActionsId(null);
                              }}
                              aria-label="Delete custom card type"
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
                    <p className="text-sm text-neutral-500">
                      No custom card types yet.
                    </p>
                  )}
                </ul>

                <button
                  onClick={openCreateNoteType}
                  aria-label="New custom card type"
                  className="mt-2 flex h-10 w-full items-center justify-center rounded-md border border-neutral-800 text-neutral-400 hover:text-neutral-200"
                >
                  <Plus size={16} />
                </button>
              </>
            ) : (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <button
                    onClick={() => {
                      setNoteTypeError("");
                      setNoteTypePage("list");
                    }}
                    aria-label="Back"
                    className="text-neutral-400 hover:text-neutral-200"
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <p className="text-sm font-medium">
                    {editingNoteTypeId ? "Edit card type" : "New card type"}
                  </p>
                </div>

                <form onSubmit={handleSubmitNoteType} className="space-y-2">
                  <input
                    value={newTypeName}
                    onChange={(e) => {
                      setNewTypeName(e.target.value);
                      setNoteTypeError("");
                    }}
                    placeholder="Name (e.g. Vocabulary)"
                    autoFocus
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                  />
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-neutral-400">
                      Question fields
                    </p>
                    {newQuestionFields.map((field, i) => (
                      <div
                        key={i}
                        draggable={newQuestionFields.length > 1}
                        onDragStart={(e) => {
                          if (!dragHandleActivatedQRef.current) {
                            e.preventDefault();
                            return;
                          }
                          dragHandleActivatedQRef.current = false;
                          dragIndexQRef.current = i;
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragOverIndexQ(i);
                        }}
                        onDrop={() => {
                          const from = dragIndexQRef.current;
                          if (from !== null && dragOverIndexQ !== null)
                            setNewQuestionFields((fs) =>
                              swapItems(fs, from, dragOverIndexQ),
                            );
                          dragIndexQRef.current = null;
                          setDragOverIndexQ(null);
                        }}
                        onDragEnd={() => {
                          dragHandleActivatedQRef.current = false;
                          dragIndexQRef.current = null;
                          setDragOverIndexQ(null);
                        }}
                        className={`space-y-1 rounded-md border p-2 transition-colors ${
                          dragOverIndexQ === i && dragIndexQRef.current !== i
                            ? "border-neutral-400 bg-neutral-800/60"
                            : "border-neutral-800"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            {newQuestionFields.length > 1 && (
                              <span
                                onPointerDown={() => {
                                  dragHandleActivatedQRef.current = true;
                                }}
                                className="flex shrink-0 cursor-grab items-center text-neutral-600 hover:text-neutral-400 active:cursor-grabbing"
                                title="Drag to reorder"
                              >
                                <GripVertical size={14} />
                              </span>
                            )}
                            <FieldTypeConfigToggle
                              value={field.type}
                              onChange={(type) =>
                                setNewQuestionFields((fs) =>
                                  fs.map((f, fi) =>
                                    fi === i ? { ...f, type, choices: [] } : f,
                                  ),
                                )
                              }
                            />
                          </div>
                          {newQuestionFields.length > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                setNewQuestionFields((fs) =>
                                  fs.filter((_, fi) => fi !== i),
                                )
                              }
                              aria-label="Remove field"
                              className="shrink-0 text-neutral-500 hover:text-neutral-300"
                            >
                              <X size={16} />
                            </button>
                          )}
                        </div>
                        {field.type === "richtext" ||
                        field.type === "choice" ? (
                          <RichTextInput
                            value={buildFormattedText(field.name, field.format)}
                            onChange={(html) =>
                              setNewQuestionFields((fs) =>
                                fs.map((f, fi) =>
                                  fi === i
                                    ? {
                                        ...f,
                                        name: stripHtml(html).trim(),
                                        format: readTextFormat(html),
                                      }
                                    : f,
                                ),
                              )
                            }
                            placeholder="Field name (e.g. Word)"
                            formatEntireValue
                          />
                        ) : (
                          <input
                            value={field.name}
                            onChange={(e) =>
                              setNewQuestionFields((fs) =>
                                fs.map((f, fi) =>
                                  fi === i ? { ...f, name: e.target.value } : f,
                                ),
                              )
                            }
                            placeholder="Field name (e.g. Word)"
                            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                          />
                        )}
                        {field.type === "choice" && (
                          <TagsInput
                            value={field.choices}
                            onChange={(choices) =>
                              setNewQuestionFields((fs) =>
                                fs.map((f, fi) =>
                                  fi === i ? { ...f, choices } : f,
                                ),
                              )
                            }
                            placeholder="Type an option, press Enter…"
                          />
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        setNewQuestionFields((fs) => [
                          ...fs,
                          {
                            name: "",
                            type: "richtext",
                            choices: [],
                            format: NORMAL_TEXT_FORMAT,
                          },
                        ])
                      }
                      aria-label="Add question field"
                      className="flex h-8 w-full items-center justify-center rounded-md border border-neutral-800 text-neutral-400 hover:text-neutral-200"
                    >
                      <Plus size={14} />
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-neutral-400">
                      Answer fields
                    </p>
                    {newAnswerFields.map((field, i) => (
                      <div
                        key={i}
                        draggable={newAnswerFields.length > 1}
                        onDragStart={(e) => {
                          if (!dragHandleActivatedARef.current) {
                            e.preventDefault();
                            return;
                          }
                          dragHandleActivatedARef.current = false;
                          dragIndexARef.current = i;
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragOverIndexA(i);
                        }}
                        onDrop={() => {
                          const from = dragIndexARef.current;
                          if (from !== null && dragOverIndexA !== null)
                            setNewAnswerFields((fs) =>
                              swapItems(fs, from, dragOverIndexA),
                            );
                          dragIndexARef.current = null;
                          setDragOverIndexA(null);
                        }}
                        onDragEnd={() => {
                          dragHandleActivatedARef.current = false;
                          dragIndexARef.current = null;
                          setDragOverIndexA(null);
                        }}
                        className={`space-y-1 rounded-md border p-2 transition-colors ${
                          dragOverIndexA === i && dragIndexARef.current !== i
                            ? "border-neutral-400 bg-neutral-800/60"
                            : "border-neutral-800"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            {newAnswerFields.length > 1 && (
                              <span
                                onPointerDown={() => {
                                  dragHandleActivatedARef.current = true;
                                }}
                                className="flex shrink-0 cursor-grab items-center text-neutral-600 hover:text-neutral-400 active:cursor-grabbing"
                                title="Drag to reorder"
                              >
                                <GripVertical size={14} />
                              </span>
                            )}
                            <FieldTypeConfigToggle
                              value={field.type}
                              onChange={(type) =>
                                setNewAnswerFields((fs) =>
                                  fs.map((f, fi) =>
                                    fi === i ? { ...f, type, choices: [] } : f,
                                  ),
                                )
                              }
                            />
                          </div>
                          {newAnswerFields.length > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                setNewAnswerFields((fs) =>
                                  fs.filter((_, fi) => fi !== i),
                                )
                              }
                              aria-label="Remove field"
                              className="shrink-0 text-neutral-500 hover:text-neutral-300"
                            >
                              <X size={16} />
                            </button>
                          )}
                        </div>
                        {field.type === "richtext" ||
                        field.type === "choice" ? (
                          <RichTextInput
                            value={buildFormattedText(field.name, field.format)}
                            onChange={(html) =>
                              setNewAnswerFields((fs) =>
                                fs.map((f, fi) =>
                                  fi === i
                                    ? {
                                        ...f,
                                        name: stripHtml(html).trim(),
                                        format: readTextFormat(html),
                                      }
                                    : f,
                                ),
                              )
                            }
                            placeholder="Field name (e.g. Meaning)"
                            formatEntireValue
                          />
                        ) : (
                          <input
                            value={field.name}
                            onChange={(e) =>
                              setNewAnswerFields((fs) =>
                                fs.map((f, fi) =>
                                  fi === i ? { ...f, name: e.target.value } : f,
                                ),
                              )
                            }
                            placeholder="Field name (e.g. Meaning)"
                            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
                          />
                        )}
                        {field.type === "choice" && (
                          <TagsInput
                            value={field.choices}
                            onChange={(choices) =>
                              setNewAnswerFields((fs) =>
                                fs.map((f, fi) =>
                                  fi === i ? { ...f, choices } : f,
                                ),
                              )
                            }
                            placeholder="Type an option, press Enter…"
                          />
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        setNewAnswerFields((fs) => [
                          ...fs,
                          {
                            name: "",
                            type: "richtext",
                            choices: [],
                            format: NORMAL_TEXT_FORMAT,
                          },
                        ])
                      }
                      aria-label="Add answer field"
                      className="flex h-8 w-full items-center justify-center rounded-md border border-neutral-800 text-neutral-400 hover:text-neutral-200"
                    >
                      <Plus size={14} />
                    </button>
                  </div>

                  <label className="flex w-fit items-center gap-2 text-xs text-neutral-400">
                    <Checkbox
                      checked={newTypeReversed}
                      onChange={setNewTypeReversed}
                    />
                    Allow reversed cards (lets you opt in per note when creating
                    a card)
                  </label>

                  {noteTypeError && (
                    <p className="text-sm text-red-400">{noteTypeError}</p>
                  )}

                  <button
                    type="submit"
                    className="w-full rounded-md bg-neutral-100 py-2 text-sm font-medium text-neutral-900"
                  >
                    {editingNoteTypeId ? "Save" : "Create"}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmState}
        title={confirmState?.title ?? ""}
        message={confirmState?.message ?? ""}
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />

      {showResetConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShowResetConfirm(false)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-red-400">Reset all data</p>
              <button
                onClick={() => setShowResetConfirm(false)}
                aria-label="Close"
                className="text-neutral-400 hover:text-neutral-200"
              >
                <X size={16} />
              </button>
            </div>
            <p className="mb-3 text-sm text-neutral-400">
              This permanently deletes every deck, card, note type, and review
              event — on this device, on the server, and on every other device
              signed into this account once it next syncs. There is no undo.
            </p>
            <label className="block">
              <span className="text-xs text-neutral-500">
                Type{" "}
                <span className="font-mono font-semibold text-neutral-300">
                  RESET
                </span>{" "}
                to confirm
              </span>
              <input
                value={resetConfirmText}
                onChange={(e) => setResetConfirmText(e.target.value)}
                autoFocus
                className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
              />
            </label>
            <div className="mt-3 flex gap-2">
              <button
                onClick={handleResetAllData}
                disabled={resetConfirmText !== "RESET"}
                className="flex-1 rounded-md bg-red-900/50 py-2 text-sm font-medium text-red-200 disabled:opacity-40"
              >
                Delete everything
              </button>
              <button
                onClick={() => setShowResetConfirm(false)}
                className="flex-1 rounded-md border border-neutral-700 py-2 text-sm text-neutral-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {actionsAddCardDeck && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setActionsAddCardDeck(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-sm overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">
                New card in &ldquo;{deckDisplayName(actionsAddCardDeck.name)}
                &rdquo;
              </p>
              <button
                onClick={() => setActionsAddCardDeck(null)}
                aria-label="Close"
                className="text-neutral-400 hover:text-neutral-200"
              >
                <X size={16} />
              </button>
            </div>

            <CardForm
              mode="create"
              onSubmit={async (data) => {
                if (!user) return;
                await createCard(
                  user.id,
                  actionsAddCardDeck.id,
                  data.cardType,
                  data.front,
                  data.back,
                  data.tags,
                  data.fields,
                  data.reversed,
                );
                setActionsAddCardDeck(null);
              }}
              onCancel={() => setActionsAddCardDeck(null)}
            />
          </div>
        </div>
      )}
    </main>
  );
}
