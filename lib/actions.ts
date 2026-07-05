import {
  db,
  LEECH_THRESHOLD,
  DEFAULT_NEW_CARDS_PER_DAY,
  DEFAULT_REVIEWS_PER_DAY,
} from './db';
import { logEvent, replayAllEvents, pushEvents } from './sync';
import { stateLabel, type Grade } from './fsrs';
import { getTodayCounts } from './stats';
import { getDeckAndDescendantIds } from './decks';

// After every write, we replay locally (instant, no network) and
// fire-and-forget a push to Supabase (don't block the UI on network).

/** Creates a deck, auto-creating any missing ancestors for "Parent::Child" names
 * (Anki's own convention — decks have no separate parentId, just a delimited name). */
export async function createDeck(userId: string, name: string) {
  const parts = name.split('::').filter(Boolean);
  const existingNames = new Set((await db.decks.toArray()).map((d) => d.name));

  let path = '';
  for (const part of parts) {
    path = path ? `${path}::${part}` : part;
    if (!existingNames.has(path)) {
      await logEvent(userId, crypto.randomUUID(), 'deck_create', { name: path });
      existingNames.add(path);
    }
  }
  await replayAllEvents();
  void pushEvents();

  const leaf = (await db.decks.toArray()).find((d) => d.name === path);
  return leaf?.id ?? '';
}

export async function editDeck(
  userId: string,
  deckId: string,
  changes: Partial<{ name: string; newCardsPerDay: number; reviewsPerDay: number }>
) {
  if (changes.name) {
    const deck = await db.decks.get(deckId);
    if (deck && deck.name !== changes.name) {
      // Renaming a parent must cascade to its descendants, or they'd detach
      // from the hierarchy (their name would no longer start with the new prefix).
      const descendants = await db.decks.where('name').startsWith(`${deck.name}::`).toArray();
      for (const child of descendants) {
        await logEvent(userId, child.id, 'deck_edit', {
          name: changes.name + child.name.slice(deck.name.length),
        });
      }
    }
  }
  await logEvent(userId, deckId, 'deck_edit', changes);
  await replayAllEvents();
  void pushEvents();
}

export async function deleteDeck(userId: string, deckId: string) {
  const deck = await db.decks.get(deckId);
  const descendants = deck
    ? await db.decks.where('name').startsWith(`${deck.name}::`).toArray()
    : [];
  const decksToDelete = deck ? [deck, ...descendants] : [];

  for (const d of decksToDelete) {
    const cards = await db.cards.where('deckId').equals(d.id).filter((c) => !c.deleted).toArray();
    // Delete by noteId, not card.id — for cloze cards those differ (id is the
    // derived `${noteId}::${clozeIndex}`), and card_delete only matches notes.
    const noteIds = new Set(cards.map((c) => c.noteId));
    for (const noteId of noteIds) {
      await logEvent(userId, noteId, 'card_delete', {});
    }
    await logEvent(userId, d.id, 'deck_delete', {});
  }
  await replayAllEvents();
  void pushEvents();
}

/** Clones a deck, its full subdeck subtree, and every card inside (as brand-new
 * notes/cards with fresh, unstarted FSRS state — not a copy of review history).
 * Cards are grouped by noteId first so a reversed pair or multi-cloze note
 * clones back into one note that (re-)generates the same set of sibling cards,
 * rather than duplicating each already-derived card independently. */
export async function cloneDeck(userId: string, deckId: string) {
  const deck = await db.decks.get(deckId);
  if (!deck) return;

  const descendants = await db.decks.where('name').startsWith(`${deck.name}::`).toArray();
  const oldDecks = [deck, ...descendants];

  const existingNames = new Set((await db.decks.toArray()).map((d) => d.name));
  let newRootName = `${deck.name} copy`;
  for (let i = 2; existingNames.has(newRootName); i++) {
    newRootName = `${deck.name} copy ${i}`;
  }

  const newDeckIds = new Map<string, string>();
  for (const oldDeck of oldDecks) {
    const newId = crypto.randomUUID();
    newDeckIds.set(oldDeck.id, newId);
    await logEvent(userId, newId, 'deck_create', {
      name: newRootName + oldDeck.name.slice(deck.name.length),
      newCardsPerDay: oldDeck.newCardsPerDay,
      reviewsPerDay: oldDeck.reviewsPerDay,
    });
  }

  for (const oldDeck of oldDecks) {
    const newDeckId = newDeckIds.get(oldDeck.id)!;
    const cards = await db.cards.where('deckId').equals(oldDeck.id).filter((c) => !c.deleted).toArray();

    const byNote = new Map<string, typeof cards>();
    for (const card of cards) {
      const group = byNote.get(card.noteId) ?? [];
      group.push(card);
      byNote.set(card.noteId, group);
    }

    for (const group of byNote.values()) {
      const rep = group.find((c) => !c.isReversed) ?? group[0];
      const reversed = group.some((c) => c.isReversed);
      const cardType = rep.cardType === 'custom' ? rep.noteTypeId! : rep.cardType;
      await logEvent(userId, crypto.randomUUID(), 'card_create', {
        deckId: newDeckId,
        cardType,
        front: rep.front,
        back: rep.back,
        tags: rep.tags,
        fields: rep.cardType === 'custom' ? rep.fields : undefined,
        reversed,
      });
    }
  }

  await replayAllEvents();
  void pushEvents();
  return newDeckIds.get(deck.id);
}

/** cardType is 'basic' | 'cloze', or a NoteType id for a custom note type —
 * in the latter case, pass its field values via `fields`. `reversed` only
 * applies to 'basic': it also generates an independently-scheduled
 * back->front sibling card, matching Anki's "Basic (and reversed card)". */
export async function createCard(
  userId: string,
  deckId: string,
  cardType: string,
  front: string,
  back: string,
  tags: string[] = [],
  fields?: Record<string, string>,
  reversed = false
) {
  const id = crypto.randomUUID();
  await logEvent(userId, id, 'card_create', { deckId, cardType, front, back, tags, fields, reversed });
  await replayAllEvents();
  void pushEvents();
  return id;
}

export async function editCard(
  userId: string,
  cardId: string,
  changes: Partial<{
    front: string;
    back: string;
    fields: Record<string, string>;
    tags: string[];
    reversed: boolean;
    flagged: boolean;
    suspended: boolean;
    isLeech: boolean;
  }>
) {
  await logEvent(userId, cardId, 'card_edit', changes);
  await replayAllEvents();
  void pushEvents();
}

export async function createNoteType(
  userId: string,
  name: string,
  fields: string[],
  questionFields: string[],
  answerFields: string[],
  reversed = false
) {
  const id = crypto.randomUUID();
  await logEvent(userId, id, 'notetype_create', {
    name,
    fields,
    questionFields,
    answerFields,
    reversed,
  });
  await replayAllEvents();
  void pushEvents();
  return id;
}

export async function editNoteType(
  userId: string,
  noteTypeId: string,
  changes: Partial<{
    name: string;
    fields: string[];
    questionFields: string[];
    answerFields: string[];
    reversed: boolean;
  }>
) {
  await logEvent(userId, noteTypeId, 'notetype_edit', changes);
  await replayAllEvents();
  void pushEvents();
}

/** Doesn't cascade to notes using this type — their cards simply stop being
 * generated on the next replay (same as any other event whose target vanished),
 * rather than being destroyed. Simpler than blocking or cascading deletes for a
 * personal app; revisit if this ever surprises someone. */
export async function deleteNoteType(userId: string, noteTypeId: string) {
  await logEvent(userId, noteTypeId, 'notetype_delete', {});
  await replayAllEvents();
  void pushEvents();
}

export async function cloneNoteType(userId: string, noteTypeId: string) {
  const nt = await db.noteTypes.get(noteTypeId);
  if (!nt) return;

  const existingNames = new Set(
    (await db.noteTypes.filter((n) => !n.deleted).toArray()).map((n) => n.name)
  );
  let name = `${nt.name} copy`;
  for (let i = 2; existingNames.has(name); i++) {
    name = `${nt.name} copy ${i}`;
  }

  return createNoteType(userId, name, nt.fields, nt.questionFields, nt.answerFields, nt.reversed);
}

export async function deleteCard(userId: string, cardId: string) {
  await logEvent(userId, cardId, 'card_delete', {});
  await replayAllEvents();
  void pushEvents();
}

export async function reviewCard(userId: string, cardId: string, rating: Grade) {
  const cardBefore = await db.cards.get(cardId);
  const wasNew = cardBefore ? stateLabel(cardBefore.fsrs.state) === 'New' : false;

  const event = await logEvent(userId, cardId, 'card_review', { rating, wasNew });
  await replayAllEvents();

  // Leech detection: FSRS already tracks lapses, so we just watch for it crossing
  // the threshold and log a real (permanent) suspend fact — not a replay-time
  // side effect, which would re-fire on every future replay and undo manual unsuspends.
  const cardAfter = await db.cards.get(cardId);
  if (cardAfter && !cardAfter.isLeech && cardAfter.fsrs.lapses >= LEECH_THRESHOLD) {
    await logEvent(userId, cardId, 'card_edit', { isLeech: true, suspended: true });
    await replayAllEvents();
  }

  void pushEvents();
  return event.id;
}

export async function undoReview(userId: string, cardId: string, reviewEventId: string) {
  await logEvent(userId, cardId, 'card_review_undo', { undoneEventId: reviewEventId });
  await replayAllEvents();
  void pushEvents();
}

/** Normal review queue: due cards from this deck and its subdecks, capped by
 * this deck's own remaining daily new/review allowance. */
export async function getDueCards(deckId: string) {
  const now = Date.now();
  const deckIds = await getDeckAndDescendantIds(deckId);
  const [deck, dueCards, todayCounts] = await Promise.all([
    db.decks.get(deckId),
    db.cards
      .where('deckId')
      .anyOf(deckIds)
      .filter((c) => !c.deleted && !c.suspended && c.fsrs.due <= now)
      .toArray(),
    getTodayCounts(deckId),
  ]);

  const newLimit = deck?.newCardsPerDay ?? DEFAULT_NEW_CARDS_PER_DAY;
  const reviewLimit = deck?.reviewsPerDay ?? DEFAULT_REVIEWS_PER_DAY;
  const newRemaining = Math.max(0, newLimit - todayCounts.newDone);
  const reviewRemaining = Math.max(0, reviewLimit - todayCounts.reviewsDone);

  const newCards = dueCards.filter((c) => stateLabel(c.fsrs.state) === 'New');
  const reviewCards = dueCards.filter((c) => stateLabel(c.fsrs.state) !== 'New');

  return [...newCards.slice(0, newRemaining), ...reviewCards.slice(0, reviewRemaining)];
}

/** Custom study: pull cards due within the next N days (this deck + subdecks),
 * bypassing daily limits. Reviewing early is safe — FSRS reschedules from the
 * actual review time, not the original due date, so this needs no
 * special-casing in the scheduler. */
export async function getDueCardsAhead(deckId: string, daysAhead: number) {
  const cutoff = Date.now() + daysAhead * 24 * 60 * 60 * 1000;
  const deckIds = await getDeckAndDescendantIds(deckId);
  return db.cards
    .where('deckId')
    .anyOf(deckIds)
    .filter((c) => !c.deleted && !c.suspended && c.fsrs.due <= cutoff)
    .toArray();
}
