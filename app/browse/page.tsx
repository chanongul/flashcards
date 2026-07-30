"use client";

import { useState, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, Search, Star, CheckSquare, X } from "lucide-react";
import { db } from "@/lib/db";
import { editCard, deleteCard, cloneCard } from "@/lib/actions";
import { useUser } from "@/lib/useUser";
import { CardRow } from "@/components/CardRow";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { BulkActionBar } from "@/components/BulkActionBar";
import { DeckPickerModal } from "@/components/DeckPickerModal";
import { ScrollFade } from "@/components/ScrollFade";
import { cardSearchText } from "@/lib/search";
import { useLoadingWhen } from "@/components/GlobalLoading";
import { useSmartBack } from "@/lib/useSmartBack";
import { useCardSelection } from "@/lib/useCardSelection";
import { flattenDeckTree, deckBreadcrumbCompact } from "@/lib/decks";
import { sync } from "@/lib/sync";

export default function BrowsePage() {
  const goBack = useSmartBack("/");
  const { user, loading: userLoading } = useUser();
  useLoadingWhen(userLoading || !user);
  const [query, setQuery] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const decks = useLiveQuery(
    () => db.decks.filter((d) => !d.deleted).toArray(),
    [],
  );
  const allCards = useLiveQuery(
    () => db.cards.filter((c) => !c.deleted).toArray(),
    [],
  );

  const deckNameById = new Map((decks ?? []).map((d) => [d.id, d.name]));

  const filtered = (allCards ?? []).filter((card) => {
    if (favoritesOnly && !card.flagged) return false;
    const q = query.trim().toLowerCase();
    // With the favorites filter on, an empty query still shows every
    // favorite — only plain search requires you to actually type something.
    if (!q) return favoritesOnly;
    const text = cardSearchText(card);
    const deckName = deckNameById.get(card.deckId) ?? "";
    const tags = card.tags.join(" ");
    return (
      text.toLowerCase().includes(q) ||
      deckName.toLowerCase().includes(q) ||
      tags.toLowerCase().includes(q)
    );
  });
  const hasActiveFilter = query.trim() !== "" || favoritesOnly;

  const selection = useCardSelection(filtered, user?.id);
  const [bulkMoveTargetId, setBulkMoveTargetId] = useState("");
  const [showBulkMove, setShowBulkMove] = useState(false);
  const [bulkDuplicateTargetId, setBulkDuplicateTargetId] = useState("");
  const [showBulkDuplicate, setShowBulkDuplicate] = useState(false);
  const deckRows = flattenDeckTree(decks ?? []);

  async function handleSaveEdit(
    cardId: string,
    changes: Partial<{
      front: string;
      back: string;
      fields: Record<string, string>;
      tags: string[];
      reversed: boolean;
    }>,
  ) {
    if (!user) return;
    await editCard(user.id, cardId, changes);
  }

  function handleDelete(cardId: string) {
    setConfirmState({
      title: "Delete card",
      message: "Delete this card? This cannot be undone.",
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

  async function handleMoveCard(noteId: string, deckId: string) {
    if (!user) return;
    await editCard(user.id, noteId, { deckId });
  }

  function openBulkMove() {
    setBulkMoveTargetId("");
    setShowBulkMove(true);
  }

  async function confirmBulkMove() {
    if (!bulkMoveTargetId) return;
    await selection.bulkMove(bulkMoveTargetId);
    setShowBulkMove(false);
  }

  function openBulkDuplicate() {
    setBulkDuplicateTargetId("");
    setShowBulkDuplicate(true);
  }

  async function confirmBulkDuplicate() {
    if (!bulkDuplicateTargetId) return;
    await selection.bulkDuplicate(bulkDuplicateTargetId);
    setShowBulkDuplicate(false);
  }

  function handleBulkDelete() {
    const n = selection.selectedCards.length;
    setConfirmState({
      title: "Delete cards",
      message: `Delete ${n} card${n === 1 ? "" : "s"}? This cannot be undone.`,
      onConfirm: async () => {
        await selection.bulkDelete();
        setConfirmState(null);
      },
    });
  }

  // Title gesture timers
  const REFRESH_HOLD_MS = 1_000;
  const pressStartRef = useRef<number | null>(null);

  function startPressHoldTimers() {
    pressStartRef.current = Date.now();
  }

  function cancelPressHoldTimers() {
    pressStartRef.current = null;
  }

  function endPressHoldTimers() {
    const start = pressStartRef.current;
    cancelPressHoldTimers();
    if (start === null) return;
    const heldMs = Date.now() - start;
    if (heldMs >= REFRESH_HOLD_MS) {
      window.location.reload();
    }
  }

  async function handleTitleClick() {
    if (!user) return;
    try {
      await sync(user.id);
    } catch (err) {
      console.error("Manual sync failed:", err);
    }
  }

  if (userLoading || !user) {
    return null;
  }

  return (
    <main className="mx-auto flex max-w-md flex-col px-6 h-dvh">
      <div className="shrink-0 pt-2 md:pt-6">
        <div className="mb-4 flex items-center justify-between">
          <button
            onClick={goBack}
            aria-label="Back to decks"
            className="rounded-md py-1.5 text-neutral-400 hover:text-neutral-200"
          >
            <ArrowLeft size={20} />
          </button>
          <h1
            className="cursor-pointer text-lg font-semibold"
            onMouseDown={startPressHoldTimers}
            onMouseUp={endPressHoldTimers}
            onTouchStart={startPressHoldTimers}
            onTouchEnd={endPressHoldTimers}
            onTouchCancel={cancelPressHoldTimers}
            onClick={handleTitleClick}
            role="button"
            aria-label="Sync now"
            title="Sync now"
          >
            Browse
          </h1>
          <button
            onClick={() => setFavoritesOnly((v) => !v)}
            aria-label={favoritesOnly ? "Show all cards" : "Show favorites only"}
            aria-pressed={favoritesOnly}
            className={`text-yellow-400 ${favoritesOnly ? "" : "opacity-40 hover:opacity-70"}`}
          >
            <Star size={20} fill="currentColor" />
          </button>
        </div>

        <div className="relative mb-4">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cards, tags, or deck names…"
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 py-2 pl-9 pr-3 text-sm"
          />
        </div>

        {hasActiveFilter && (
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs text-neutral-500">
              {filtered.length} card{filtered.length === 1 ? "" : "s"}
            </p>
            <button
              onClick={selection.toggleSelectMode}
              aria-label={
                selection.selectMode ? "Cancel selection" : "Select cards"
              }
              aria-pressed={selection.selectMode}
              className={
                selection.selectMode
                  ? "text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-200"
              }
            >
              {selection.selectMode ? <X size={16} /> : <CheckSquare size={16} />}
            </button>
          </div>
        )}
      </div>

      <ScrollFade fadeFrom="from-neutral-950" bleed={false}>
        <ul className={`pt-2 space-y-2 ${selection.selectMode ? "pb-24 md:pb-20" : "pb-10 md:pb-6"}`}>
          {filtered.map((card) => (
            <CardRow
              key={card.id}
              card={card}
              deckName={
              deckNameById.get(card.deckId)
                ? deckBreadcrumbCompact(deckNameById.get(card.deckId)!)
                : undefined
            }
              selectMode={selection.selectMode}
              selected={selection.selectedIds.has(card.id)}
              onToggleSelect={selection.toggleSelect}
              onSave={handleSaveEdit}
              onDelete={handleDelete}
              onToggleFlag={handleToggleFlag}
              onToggleSuspend={handleToggleSuspend}
              onClone={handleClone}
              onMoveCard={handleMoveCard}
            />
          ))}
          {hasActiveFilter ? (
            filtered.length === 0 && (
              <p className="text-sm text-neutral-500">No cards match.</p>
            )
          ) : (
            <p className="text-sm text-neutral-500">Type to search your cards.</p>
          )}
        </ul>
      </ScrollFade>

      {selection.selectMode && (
        <BulkActionBar
          count={selection.selectedCards.length}
          allSelected={selection.allSelected}
          onToggleSelectAll={selection.toggleSelectAll}
          flagLabel={selection.flagLabel}
          onFlag={selection.bulkFlag}
          suspendLabel={selection.suspendLabel}
          onSuspend={selection.bulkSuspend}
          onDuplicate={openBulkDuplicate}
          onMove={openBulkMove}
          onDelete={handleBulkDelete}
        />
      )}

      <DeckPickerModal
        open={showBulkMove}
        onClose={() => setShowBulkMove(false)}
        title={`Move ${selection.selectedCards.length} card${selection.selectedCards.length === 1 ? "" : "s"}`}
        confirmLabel="Move"
        rows={deckRows}
        value={bulkMoveTargetId}
        onChange={setBulkMoveTargetId}
        onConfirm={confirmBulkMove}
      />

      <DeckPickerModal
        open={showBulkDuplicate}
        onClose={() => setShowBulkDuplicate(false)}
        title={`Duplicate ${selection.selectedCards.length} card${selection.selectedCards.length === 1 ? "" : "s"}`}
        confirmLabel="Duplicate"
        rows={deckRows}
        value={bulkDuplicateTargetId}
        onChange={setBulkDuplicateTargetId}
        onConfirm={confirmBulkDuplicate}
      />

      <ConfirmDialog
        open={!!confirmState}
        title={confirmState?.title ?? ""}
        message={confirmState?.message ?? ""}
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />
    </main>
  );
}
