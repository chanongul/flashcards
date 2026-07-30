"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, Search, Star, CheckSquare, X } from "lucide-react";
import { db, type Card } from "@/lib/db";
import { editCard, deleteCard, cloneCard } from "@/lib/actions";
import { useUser } from "@/lib/useUser";
import { CardRow } from "@/components/CardRow";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { BulkActionBar } from "@/components/BulkActionBar";
import { DeckPickerModal } from "@/components/DeckPickerModal";
import { ScrollFade } from "@/components/ScrollFade";
import { cardSearchText } from "@/lib/search";
import {
  getDeckAndDescendantIds,
  deckBreadcrumbCompact,
  deckParentName,
  flattenDeckTree,
} from "@/lib/decks";
import { useLoadingWhen } from "@/components/GlobalLoading";
import { useSmartBack } from "@/lib/useSmartBack";
import { useTitleSync } from "@/lib/useTitleSync";
import { useCardSelection } from "@/lib/useCardSelection";

export default function DeckBrowsePage() {
  const params = useParams<{ deckId: string }>();
  const goBack = useSmartBack(`/review/${params.deckId}`);
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
  const deckNameById = new Map((decks ?? []).map((d) => [d.id, d.name]));
  const currentDeckName = deckNameById.get(params.deckId) ?? "";
  const isSubdeck = deckParentName(currentDeckName) !== null;

  // Scope: this deck plus every subdeck (matches what reviewing the deck
  // covers), rather than browse's whole-collection search.
  const deckCards = useLiveQuery(async () => {
    const deckIds = await getDeckAndDescendantIds(params.deckId);
    return db.cards
      .where("deckId")
      .anyOf(deckIds)
      .filter((c) => !c.deleted)
      .toArray();
  }, [params.deckId]);

  // Same matching algorithm as the global browse page (both share cardSearchText).
  const filtered = (deckCards ?? []).filter((card) => {
    if (favoritesOnly && !card.flagged) return false;
    const q = query.trim().toLowerCase();
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

  const {
    isOnline,
    syncError,
    startPressHoldTimers,
    cancelPressHoldTimers,
    endPressHoldTimers,
    handleTitleClick,
  } = useTitleSync({ userId: user?.id });

  async function handleToggleFlag(card: Card) {
    if (!user) return;
    await editCard(user.id, card.id, { flagged: !card.flagged });
  }

  async function handleToggleSuspend(card: Card) {
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

  if (userLoading || !user) {
    return null;
  }

  return (
    <main className="mx-auto flex max-w-md flex-col px-6 h-dvh">
      <div className="shrink-0 pt-2 md:pt-6">
        <div className="mb-4 flex items-center justify-between">
          <button
            onClick={goBack}
            aria-label="Back to review"
            className="rounded-md py-1.5 text-neutral-400 hover:text-neutral-200"
          >
            <ArrowLeft size={20} />
          </button>
          <h1
            className={`text-lg font-semibold ${isOnline ? "cursor-pointer" : "cursor-not-allowed opacity-80"}`}
            onMouseDown={startPressHoldTimers}
            onMouseUp={endPressHoldTimers}
            onTouchStart={startPressHoldTimers}
            onTouchEnd={endPressHoldTimers}
            onTouchCancel={cancelPressHoldTimers}
            onClick={handleTitleClick}
            role="button"
            aria-label={isOnline ? "Sync now" : "Offline — sync unavailable"}
            title={isOnline ? "Sync now" : "Offline — sync unavailable"}
          >
            {isSubdeck ? "Browse subdeck" : "Browse deck"}
          </h1>
          <button
            onClick={() => setFavoritesOnly((v) => !v)}
            aria-label={
              favoritesOnly ? "Show all cards" : "Show favorites only"
            }
            aria-pressed={favoritesOnly}
            className={`text-yellow-400 ${favoritesOnly ? "" : "opacity-40 hover:opacity-70"}`}
          >
            <Star size={20} fill="currentColor" />
          </button>
        </div>

        {syncError && (
          <p className="mb-4 -mt-2 text-xs text-red-400">{syncError}</p>
        )}

        <div className="relative mb-4">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search this ${isSubdeck ? "subdeck" : "deck"}'s cards…`}
            autoFocus
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 py-2 pl-9 pr-3 text-sm"
          />
        </div>

        {hasActiveFilter && (
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <p className="w-max text-xs text-neutral-500 whitespace-nowrap">
                {filtered.length} card{filtered.length === 1 ? "" : "s"}
              </p>
              <span className="truncate text-xs text-neutral-500">
                · {deckBreadcrumbCompact(currentDeckName)}
              </span>
            </div>
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
              {selection.selectMode ? (
                <X size={16} />
              ) : (
                <CheckSquare size={16} />
              )}
            </button>
          </div>
        )}
      </div>

      <ScrollFade fadeFrom="from-neutral-950" bleed={false}>
        <ul
          className={`pt-2 space-y-2 ${selection.selectMode ? "pb-24 md:pb-20" : "pb-10 md:pb-6"}`}
        >
          {filtered.map((card) => (
            <CardRow
              key={card.id}
              card={card}
              deckName={
                card.deckId !== params.deckId
                  ? deckBreadcrumbCompact(deckNameById.get(card.deckId) ?? "")
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
            <p className="text-sm text-neutral-500">
              Type to search this {isSubdeck ? "subdeck" : "deck"}'s cards.
            </p>
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
