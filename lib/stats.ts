import { db, type Card } from './db';
import { stateLabel, type Grade } from './fsrs';
import { getDeckAndDescendantIds } from './decks';
import { getResetCutoff } from './sync';

async function getUndoneReviewIds(): Promise<Set<string>> {
  const undoEvents = await db.events.where('type').equals('card_review_undo').toArray();
  return new Set(undoEvents.map((e) => e.payload.undoneEventId as string));
}

// Deck scoping for review events: reviews don't carry a deckId directly (their
// entityId is the cardId), so we resolve which cardIds belong to the deck (and
// its subdecks) first. Includes deleted cards, since past review history
// shouldn't disappear with the card.
async function getCardIdsForDeck(deckId?: string): Promise<Set<string> | null> {
  if (!deckId) return null;
  const deckIds = await getDeckAndDescendantIds(deckId);
  const cards = await db.cards.where('deckId').anyOf(deckIds).toArray();
  return new Set(cards.map((c) => c.id));
}

// Anki-style deck-list counts: new cards (not yet studied), cards mid-learning-steps
// that are due now, and review-state cards that are due now.
export interface DeckCounts {
  newCount: number;
  learningCount: number;
  dueCount: number;
}

export const DECK_COUNT_TOOLTIPS = {
  new: 'New — cards you haven’t studied yet',
  learning: 'Learning — cards in a learning/relearning step, due now',
  due: 'Due — review cards scheduled for today or earlier',
};

export function countCardsByState(cards: Card[], now: number = Date.now()): DeckCounts {
  const counts: DeckCounts = { newCount: 0, learningCount: 0, dueCount: 0 };
  for (const card of cards) {
    const label = stateLabel(card.fsrs.state);
    if (label === 'New') {
      counts.newCount++;
    } else if (card.fsrs.due <= now) {
      if (label === 'Learning' || label === 'Relearning') counts.learningCount++;
      else if (label === 'Review') counts.dueCount++;
    }
  }
  return counts;
}

// Tracks how much of a deck's daily new-card/review allowance has been used today,
// so getDueCards() can stop pulling more once the limit is hit. `wasNew` is captured
// on the review event itself (the card's state before that review), since a card's
// current state no longer reflects what it was at review time.
export async function getTodayCounts(deckId: string): Promise<{
  newDone: number;
  reviewsDone: number;
}> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [events, undone, cardIds, resetCutoff] = await Promise.all([
    db.events.where('type').equals('card_review').toArray(),
    getUndoneReviewIds(),
    getCardIdsForDeck(deckId),
    getResetCutoff(),
  ]);
  const todays = events.filter(
    (e) =>
      e.timestamp >= startOfDay.getTime() &&
      (resetCutoff === null || e.timestamp > resetCutoff) &&
      !undone.has(e.id) &&
      (cardIds === null || cardIds.has(e.entityId))
  );
  const newDone = todays.filter((e) => e.payload.wasNew === true).length;
  return { newDone, reviewsDone: todays.length - newDone };
}

export interface ReviewHistoryEntry {
  id: string;
  timestamp: number;
  rating: Grade;
  undone: boolean;
}

export async function getCardReviewHistory(cardId: string): Promise<ReviewHistoryEntry[]> {
  const [events, undone, resetCutoff] = await Promise.all([
    db.events.where('entityId').equals(cardId).toArray(),
    getUndoneReviewIds(),
    getResetCutoff(),
  ]);
  return events
    .filter((e) => e.type === 'card_review' && (resetCutoff === null || e.timestamp > resetCutoff))
    .map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      rating: e.payload.rating as Grade,
      undone: undone.has(e.id),
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/** Local-calendar-day key (not UTC — a review just before midnight shouldn't
 * count for the next day just because toISOString() shifted timezone). */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Review counts per local calendar day, for the heatmap. Excludes undone reviews. */
export async function getDailyReviewCounts(daysBack: number): Promise<Map<string, number>> {
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const [events, undone, resetCutoff] = await Promise.all([
    db.events.where('type').equals('card_review').toArray(),
    getUndoneReviewIds(),
    getResetCutoff(),
  ]);
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.timestamp < cutoff || undone.has(e.id)) continue;
    if (resetCutoff !== null && e.timestamp <= resetCutoff) continue;
    const key = dateKey(new Date(e.timestamp));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
